import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  messageText,
  pollHistory,
  sendChat,
  waitForRun,
  type GatewayChatRun,
  type GatewayChatHistory,
} from "./gateway-recovery.test-support.js";

type StabilityEvent = {
  type?: unknown;
  action?: unknown;
  reason?: unknown;
  outcome?: unknown;
  ageMs?: unknown;
  queueDepth?: unknown;
  source?: unknown;
};

type StabilitySnapshot = {
  lastSeq?: unknown;
  events?: StabilityEvent[];
};

type MockRequestSnapshot = Partial<
  Record<"cursor" | "prompt" | "allInputText" | "model" | "outcome" | "errorCode", unknown>
>;

type ClassifiedMockRequest = {
  cursor: unknown;
  model: unknown;
  continuation: boolean;
  prompt: "recovery" | "queued" | "other" | "missing";
  stallGuidance: boolean;
  outcome: unknown;
  errorCode: unknown;
};

const RECOVERY_PROMPT =
  "Repeated request recovery Gateway QA check. Keep attempting without producing a reply.";
const QUEUED_PROMPT =
  "Repeated request queued reply Gateway QA check. Reply with the fixture marker.";
const QUEUED_REPLY_MARKER = "GATEWAY_REPEATED_REQUEST_QUEUED_OK";
const RECOVERY_REASON = "repeated_model_requests_without_progress";
const STALL_GUIDANCE_NEEDLE = "previous turn stopped making progress";
// The opt-in proof owns the 360-second floor; this proof uses the same heartbeat with QA timings.
const QA_RECOVERY_BOUND_MS = 30_000;
const MODEL_REQUEST_ALLOWANCE_SECONDS = 45;
const ORDINARY_RESPONSE_PAUSE_MS = 8_000;
// Keepalives leave a 45-second recovery window before the 90-second progress deadline,
// guaranteeing at least one 30-second diagnostic heartbeat after the allowance.
const STALLED_RESPONSE_PAUSE_MS = 90_000;
const RECOVERY_PROGRESS_INTERVAL_MS = 30_000;
const HISTORY_RETRY_TIMEOUT_MS = 60_000;
const HISTORY_RETRY_INTERVAL_MS = 250;

type GatewayHarness = Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>>;
type Gateway = GatewayHarness["gateway"];
let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let harness: GatewayHarness | undefined;

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner);
  }
  harness = undefined;
  gatewayOwner = undefined;
});

async function readStability(gateway: Gateway, sinceSeq?: number): Promise<StabilitySnapshot> {
  return (await gateway.call(
    "diagnostics.stability",
    { limit: 1000, ...(sinceSeq === undefined ? {} : { sinceSeq }) },
    { timeoutMs: 10_000 },
  )) as StabilitySnapshot;
}

async function waitForStability(
  gateway: Gateway,
  sinceSeq: number,
  predicate: (events: StabilityEvent[]) => boolean,
  timeoutMs: number,
): Promise<StabilityEvent[]> {
  const startedAt = Date.now();
  let nextProgressAt = RECOVERY_PROGRESS_INTERVAL_MS;
  let latest: StabilityEvent[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    latest = (await readStability(gateway, sinceSeq)).events ?? [];
    if (predicate(latest)) {
      return latest;
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= nextProgressAt) {
      // Vitest suppresses test console output; write to the worker fd so the outer
      // no-output watchdog can distinguish this production-length poll from a stalled worker.
      writeSync(
        2,
        `[gateway-repeated-request-recovery] waiting for stability evidence (${elapsedMs}ms, ${latest.length} events)\n`,
      );
      nextProgressAt += RECOVERY_PROGRESS_INTERVAL_MS;
    }
    await sleep(1_000);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for stability events: ${JSON.stringify(latest)}`,
  );
}

function historyContainsQueuedReply(history: GatewayChatHistory): boolean {
  const messages = history.messages ?? [];
  const queuedIndex = messages.findLastIndex(
    (message) => message.role === "user" && messageText(message).includes(QUEUED_PROMPT),
  );
  return (
    queuedIndex >= 0 &&
    messages
      .slice(queuedIndex + 1)
      .some(
        (message) => message.role === "assistant" && messageText(message) === QUEUED_REPLY_MARKER,
      )
  );
}

async function waitForQueuedReply(
  gateway: Gateway,
  sessionKey: string,
): Promise<GatewayChatHistory> {
  return pollHistory(
    () =>
      gateway.call(
        "chat.history",
        { sessionKey, limit: 20 },
        { timeoutMs: 10_000 },
      ) as Promise<GatewayChatHistory>,
    historyContainsQueuedReply,
    HISTORY_RETRY_TIMEOUT_MS,
    HISTORY_RETRY_INTERVAL_MS,
    (history) =>
      `timed out waiting for queued reply in chat.history after ${HISTORY_RETRY_TIMEOUT_MS}ms: ${JSON.stringify(
        (history?.messages ?? []).map((message) => ({
          role: message.role,
          text: messageText(message),
        })),
      )}`,
  );
}

async function readClassifiedMockRequests(mockBaseUrl: string): Promise<ClassifiedMockRequest[]> {
  return fetch(`${mockBaseUrl}/debug/requests`)
    .then((response) => response.json() as Promise<MockRequestSnapshot[]>)
    .then((records) =>
      records.map(({ cursor, prompt, allInputText, model, outcome, errorCode }) => ({
        cursor,
        model,
        continuation:
          typeof prompt === "string" &&
          !prompt.includes(RECOVERY_PROMPT) &&
          !prompt.includes(QUEUED_PROMPT) &&
          typeof allInputText === "string" &&
          allInputText.includes(RECOVERY_PROMPT),
        prompt:
          typeof prompt === "string"
            ? prompt.includes(QUEUED_PROMPT)
              ? "queued"
              : typeof allInputText === "string" && allInputText.includes(RECOVERY_PROMPT)
                ? "recovery"
                : "other"
            : "missing",
        stallGuidance:
          typeof allInputText === "string" && allInputText.includes(STALL_GUIDANCE_NEEDLE),
        outcome,
        errorCode,
      })),
    );
}

async function readFailureEvidence(params: {
  gateway: Gateway;
  mockBaseUrl: string | undefined;
  sinceSeq: number;
}): Promise<string> {
  const events = (await readStability(params.gateway, params.sinceSeq)).events ?? [];
  const stability = events
    .filter(
      (event) =>
        typeof event.type === "string" &&
        (event.type.startsWith("session.") ||
          event.type === "message.queued" ||
          event.type === "model.call.started"),
    )
    .map(({ type, action, reason, outcome, ageMs, queueDepth, source }) => ({
      type,
      action,
      reason,
      outcome,
      ageMs,
      queueDepth,
      source,
    }));
  const requests = params.mockBaseUrl
    ? await readClassifiedMockRequests(params.mockBaseUrl).catch((error: unknown) => [
        { requestEvidenceError: String(error) },
      ])
    : [];
  const gatewayLogs = params.gateway
    .logs()
    .split("\n")
    .filter((line) =>
      /followup queue|reply run stale takeover|stuck session recovery|queue: active session/iu.test(
        line,
      ),
    )
    .slice(-100);
  return JSON.stringify({ stability, requests, gatewayLogs });
}

it(
  "recovers semantic stagnation and settles the active run before draining one queued followup",
  { timeout: 330_000 },
  async () => {
    gatewayOwner = createQaLiveLaneGateway();
    harness = await gatewayOwner.start({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      transport: {
        requiredPluginIds: [],
        createGatewayConfig: () => ({
          messages: { queue: { mode: "followup" } },
        }),
      },
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      mockProviderOptions: {
        repeatedRequestResponsePauseMs: ORDINARY_RESPONSE_PAUSE_MS,
        repeatedRequestStalledResponsePauseMs: STALLED_RESPONSE_PAUSE_MS,
      },
      runtimeEnvPatch: {
        QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: String(QA_RECOVERY_BOUND_MS),
      },
      mutateConfig: (config) => {
        const models = config.models;
        const provider = models?.providers?.["mock-openai"];
        if (!models || !provider) {
          throw new Error("mock-openai provider config unavailable");
        }
        provider.timeoutSeconds = MODEL_REQUEST_ALLOWANCE_SECONDS;
        config.diagnostics = { enabled: true };
        return config;
      },
    });
    const { gateway } = harness;
    expect(gateway.runtimeEnv.QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS).toBe(
      String(QA_RECOVERY_BOUND_MS),
    );
    expect(gateway.runtimeEnv.OPENCLAW_GATEWAY_HOST_LIFELINE).toBe("stdin");

    const baseline = await readStability(gateway);
    const baselineSeq = typeof baseline.lastSeq === "number" ? baseline.lastSeq : 0;
    const sessionKey = `agent:qa:repeated-request-recovery-${randomUUID()}`;
    const active = await sendChat(gateway, sessionKey, RECOVERY_PROMPT);
    expect(active).toMatchObject({ status: "started" });
    expect(typeof active.runId).toBe("string");

    await waitForStability(
      gateway,
      baselineSeq,
      (events) => events.filter((event) => event.type === "model.call.started").length >= 2,
      100_000,
    );

    const queued = await sendChat(gateway, sessionKey, QUEUED_PROMPT, { queueMode: "followup" });
    expect(queued).toMatchObject({ status: "started" });
    expect(typeof queued.runId).toBe("string");

    // Repeated-request recovery interrupts the live-but-silent fallback after its
    // own request allowance expires. Observe that recovery before queue drain.
    const events = await waitForStability(
      gateway,
      baselineSeq,
      (records) => records.some((event) => event.type === "session.recovery.completed"),
      250_000,
    );
    const stalled = events.filter(
      (event) => event.type === "session.stalled" && event.reason === RECOVERY_REASON,
    );
    const requested = events.filter(
      (event) => event.type === "session.recovery.requested" && event.reason === RECOVERY_REASON,
    );
    const completed = events.filter((event) => event.type === "session.recovery.completed");

    // Heartbeats may observe a stall more than once; recovery still owns one abort.
    expect(stalled.length).toBeGreaterThan(0);
    for (const event of stalled) {
      expect(event.ageMs).toEqual(expect.any(Number));
      expect(event.ageMs as number).toBeGreaterThanOrEqual(QA_RECOVERY_BOUND_MS);
    }
    expect(requested).toEqual([
      expect.objectContaining({ action: "abort", reason: RECOVERY_REASON }),
    ]);
    expect(completed).toEqual([
      // An active model call is interrupted like an idle timeout, so the run
      // keeps its lane and settles through its remaining fallback retries.
      expect.objectContaining({
        action: "keep_lane",
        outcome: "skipped",
        reason: "model_attempt_recovery",
      }),
    ]);
    expect(
      events.filter((event) => event.type === "model.call.started").length,
    ).toBeGreaterThanOrEqual(5);

    const activeTerminal = await waitForRun(gateway, active.runId);
    expect(activeTerminal).toMatchObject({
      status: "error",
      endedAt: expect.any(Number),
    });

    const history = await waitForQueuedReply(gateway, sessionKey).catch(async (error: unknown) => {
      const evidence = await readFailureEvidence({
        gateway,
        mockBaseUrl: harness?.mock?.baseUrl,
        sinceSeq: baselineSeq,
      });
      throw new Error(`${String(error)}; evidence=${evidence}`, { cause: error });
    });
    expect(historyContainsQueuedReply(history)).toBe(true);
    // agent.wait returns pending immediately while the queue owns this run,
    // even after its reply is visible. Observe settlement within the same budget.
    const queuedDeadline = Date.now() + 30_000;
    let queuedTerminal: GatewayChatRun;
    do {
      const remainingMs = Math.max(1, queuedDeadline - Date.now());
      queuedTerminal = await waitForRun(gateway, queued.runId, remainingMs, remainingMs);
      if (queuedTerminal.status !== "pending") {
        break;
      }
      await sleep(Math.max(0, Math.min(100, queuedDeadline - Date.now())));
    } while (Date.now() < queuedDeadline);
    expect(queuedTerminal.status).toBe("ok");
    const mockBaseUrl = harness?.mock?.baseUrl;
    if (!mockBaseUrl) {
      throw new Error("mock provider request evidence unavailable");
    }
    const requests = await readClassifiedMockRequests(mockBaseUrl);
    const recoveryRequests = requests.filter((request) => request.prompt === "recovery");
    // Invisible replay-safe errors exhaust the primary model's retry budget;
    // the diagnostic owner then interrupts the stalled fallback request, and the
    // fallback's own retries fail fast until the run settles.
    // The mock records intent before delay; lifecycle checks above prove actual interruption.
    expect(recoveryRequests).toEqual([
      ...Array.from({ length: 4 }, () =>
        expect.objectContaining({
          model: "gpt-5.6-luna",
          continuation: false,
          outcome: "error",
          errorCode: "response_failed_no_details",
        }),
      ),
      ...Array.from({ length: 5 }, () =>
        expect.objectContaining({
          model: "gpt-5.6-luna-alt",
          outcome: "error",
          errorCode: "response_failed_no_details",
        }),
      ),
    ]);
    // The interrupted attempt settles as a fallback failure rather than a
    // stuck-run abort, so the queued request answers without stalled-turn guidance.
    expect(requests.filter((request) => request.prompt === "queued")).toEqual([
      expect.objectContaining({ outcome: "success", stallGuidance: false }),
    ]);

    const finalEvents = (await readStability(gateway, baselineSeq)).events ?? [];
    expect(finalEvents.filter((event) => event.type === "session.recovery.requested")).toHaveLength(
      1,
    );
    expect(finalEvents.filter((event) => event.type === "session.recovery.completed")).toHaveLength(
      1,
    );
  },
);
