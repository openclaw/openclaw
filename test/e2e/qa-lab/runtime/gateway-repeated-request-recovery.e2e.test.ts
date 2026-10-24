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

type StabilityEvent = Partial<Record<"ts" | "type" | "reason" | "ageMs" | "failureKind", unknown>>;

type StabilitySnapshot = {
  lastSeq?: unknown;
  events?: StabilityEvent[];
};

type MockRequestSnapshot = Partial<
  Record<"cursor" | "prompt" | "allInputText" | "model" | "outcome" | "errorCode", unknown>
>;

type ClassifiedMockRequest = Record<"cursor" | "model" | "outcome" | "errorCode", unknown> & {
  continuation: boolean;
  prompt: "recovery" | "queued" | "other" | "missing";
  stallGuidance: boolean;
};

const RECOVERY_PROMPT =
  "Repeated request recovery Gateway QA check. Keep attempting without producing a reply.";
const QUEUED_PROMPT =
  "Repeated request queued reply Gateway QA check. Reply with the fixture marker.";
const QUEUED_REPLY_MARKER = "GATEWAY_REPEATED_REQUEST_QUEUED_OK";
const RECOVERY_REASON = "repeated_model_requests_without_progress";
const STALL_GUIDANCE_NEEDLE = "previous turn stopped making progress";
// Shorten diagnostic reporting, not the controller-owned semantic recovery floor.
const QA_STALL_BOUND_MS = 30_000;
const MODEL_REQUEST_ALLOWANCE_SECONDS = 45;
// The repeated-request clock starts on the first retry, not the initial request.
// Three 12-second failures leave a 39-second reporting window before the fourth
// request times out, covering a 30-second heartbeat without extending its deadline.
const ORDINARY_RESPONSE_PAUSE_MS = 12_000;
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

it(
  "lets the provider deadline settle the failed run before draining one queued followup",
  { timeout: 330_000 },
  async () => {
    gatewayOwner = createQaLiveLaneGateway();
    harness = await gatewayOwner.start({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna",
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
        QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: String(QA_STALL_BOUND_MS),
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
    expect(gateway.runtimeEnv.QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS).toBe(String(QA_STALL_BOUND_MS));
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

    // The provider deadline, not a diagnostic tick, owns settlement. The diagnostic
    // duration can be shorter than timeoutSeconds because observation starts later.
    const events = await waitForStability(
      gateway,
      baselineSeq,
      (records) =>
        records.some(
          (event) => event.type === "model.call.error" && event.failureKind === "timeout",
        ),
      250_000,
    );
    const stalled = events.filter(
      (event) => event.type === "session.stalled" && event.reason === RECOVERY_REASON,
    );
    const requested = events.filter((event) => event.type === "session.recovery.requested");
    const completed = events.filter((event) => event.type === "session.recovery.completed");

    // Heartbeats may report the stall repeatedly without competing with the provider.
    expect(stalled.length).toBeGreaterThan(0);
    for (const event of stalled) {
      expect(event.ageMs).toEqual(expect.any(Number));
      expect(event.ageMs as number).toBeGreaterThanOrEqual(QA_STALL_BOUND_MS);
    }
    expect(requested).toEqual([]);
    expect(completed).toEqual([]);
    expect(
      events.filter((event) => event.type === "model.call.started").length,
    ).toBeGreaterThanOrEqual(4);

    const activeTerminal = await waitForRun(gateway, active.runId);
    expect(activeTerminal).toMatchObject({
      status: "error",
      endedAt: expect.any(Number),
    });

    await waitForQueuedReply(gateway, sessionKey);
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
    const finalHistory = await waitForQueuedReply(gateway, sessionKey);
    expect(
      (finalHistory.messages ?? []).filter(
        (message) => message.role === "assistant" && messageText(message) === QUEUED_REPLY_MARKER,
      ),
    ).toHaveLength(1);
    const mockBaseUrl = harness?.mock?.baseUrl;
    if (!mockBaseUrl) {
      throw new Error("mock provider request evidence unavailable");
    }
    const requests = await readClassifiedMockRequests(mockBaseUrl);
    const recoveryRequests = requests.filter((request) => request.prompt === "recovery");
    // After the fourth request times out, the existing transient-retry owner makes
    // one same-model transcript continuation. Its no-details failure exhausts the
    // already-used empty-error budget. This is not diagnostic liveness recovery.
    // Mock outcomes record intent before delay; the diagnostic above proves the timeout.
    expect(recoveryRequests).toEqual([
      ...Array.from({ length: 4 }, () =>
        expect.objectContaining({
          model: "gpt-5.6-luna",
          continuation: false,
          outcome: "error",
          errorCode: "response_failed_no_details",
        }),
      ),
      expect.objectContaining({
        model: "gpt-5.6-luna",
        continuation: true,
        outcome: "error",
        errorCode: "response_failed_no_details",
      }),
    ]);
    // A provider failure is not a stuck-run abort and must not inject recovery guidance.
    expect(requests.filter((request) => request.prompt === "queued")).toEqual([
      expect.objectContaining({ outcome: "success", stallGuidance: false }),
    ]);

    const finalEvents = (await readStability(gateway, baselineSeq)).events ?? [];
    const modelStarts = finalEvents.filter((event) => event.type === "model.call.started");
    expect(modelStarts).toHaveLength(6);
    expect(modelStarts.at(-1)?.ts).toEqual(expect.any(Number));
    expect(modelStarts.at(-1)?.ts as number).toBeGreaterThanOrEqual(
      activeTerminal.endedAt as number,
    );
    expect(finalEvents.filter((event) => event.type === "session.recovery.requested")).toHaveLength(
      0,
    );
    expect(finalEvents.filter((event) => event.type === "session.recovery.completed")).toHaveLength(
      0,
    );
  },
);
