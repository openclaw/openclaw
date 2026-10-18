import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCommandLaneSnapshot, setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import {
  getReservedRpcSourceInput,
  getRpcSource,
} from "../sessions/session-controller.rpc-sources.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import * as chatRestartRecovery from "./server-methods/chat-restart-recovery.js";
import * as chatAdmission from "./server-methods/chat-send-admission.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const RESEND_MARKER = "Your previous turn was interrupted by a gateway restart";

type Fixture = {
  cfg: OpenClawConfig;
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"];
  storePath: string;
  workspaceDir: string;
  stateDir: string;
};

// The provider records every model request and holds requests that contain a held text.
const requests: string[] = [];
const holds = new Map<string, ReturnType<typeof createDeferred<void>>>();

/** Returns the prompt the model answers in one provider request. */
function activePrompt(body: string): string {
  const request = JSON.parse(body) as { input?: Array<{ role?: string; content?: unknown }> };
  const prompts = (request.input ?? [])
    .filter((message) => message.role === "user")
    .map((message) => {
      const parts = Array.isArray(message.content)
        ? (message.content as Array<{ text?: unknown }>)
        : [];
      return stripInternalRuntimeContext(
        parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n"),
      );
    });
  // Loopback Responses providers retain the trailing runtime carrier as a user frame.
  return prompts.findLast((prompt) => prompt.trim()) ?? "";
}

/** Model turns of one session, identified by its seeded text, that executed the resend. */
function resendTurns(sessionText: string): string[] {
  return requests.filter(
    (body) => body.includes(sessionText) && activePrompt(body).includes(RESEND_MARKER),
  );
}

/** Model turns whose own prompt contains `text`. */
function promptTurns(text: string): string[] {
  return requests.filter((body) => activePrompt(body).includes(text));
}

function holdProvider(text: string): () => void {
  const gate = createDeferred();
  holds.set(text, gate);
  return () => {
    holds.delete(text);
    gate.resolve();
  };
}

function readEntry(fixture: Fixture, sessionKey: string) {
  return loadSessionEntryReadOnly({ storePath: fixture.storePath, sessionKey });
}

/** Seeds a main session exactly as a Gateway restart leaves an interrupted turn. */
async function seedInterruptedSession(
  fixture: Fixture,
  params: { sessionKey: string; sessionId: string; message: string; patch?: Partial<SessionEntry> },
) {
  const target = { storePath: fixture.storePath, sessionKey: params.sessionKey };
  await replaceSessionEntry(target, {
    sessionId: params.sessionId,
    updatedAt: Date.now() - 10_000,
    status: "done",
  });
  await appendTranscriptMessage(
    { ...target, agentId: "main", sessionId: params.sessionId },
    {
      cwd: fixture.workspaceDir,
      message: {
        role: "user",
        content: params.message,
        idempotencyKey: `${params.patch?.restartRecoveryDeliverySourceRunId ?? params.sessionId}:user`,
      },
    },
  );
  await replaceSessionEntry(target, {
    sessionId: params.sessionId,
    updatedAt: Date.now() - 10_000,
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: params.sessionId, revision: 1, chargedAttempts: 0 },
    ...params.patch,
  });
  clearSessionStoreCacheForTest();
}

/** Runs the startup scan the Gateway schedules after boot. */
function runStartupRecovery(fixture: Fixture) {
  return recoverRestartAbortedMainSessions({
    cfg: fixture.cfg,
    stateDir: fixture.stateDir,
    gatewayRuntime: expectDefined(getGatewayRecoveryRuntime(), "recovery runtime"),
  });
}

/** Let startup check capacity, then pause backend execution at the real dispatch boundary. */
function holdRecoveryLane(sessionKey: string) {
  const runtime = expectDefined(getGatewayRecoveryRuntime(), "recovery runtime");
  const dispatch = runtime.dispatchAgent;
  const { maxConcurrent } = getCommandLaneSnapshot(CommandLane.RestartRecovery);
  const dispatchGate = vi
    .spyOn(runtime, "dispatchAgent")
    .mockImplementationOnce(<T>(...args: Parameters<typeof dispatch>) => {
      expect(args[0].sessionKey).toBe(sessionKey);
      setCommandLaneConcurrency(CommandLane.RestartRecovery, 0);
      return dispatch<T>(...args);
    });
  return () => {
    dispatchGate.mockRestore();
    setCommandLaneConcurrency(CommandLane.RestartRecovery, maxConcurrent);
  };
}

/** Returns the resend's run id and source once its Gateway RPC has registered the input. */
async function waitForResendSource(fixture: Fixture, sessionKey: string) {
  let runId: string | undefined;
  await vi.waitFor(
    () => {
      runId = readEntry(fixture, sessionKey)?.restartRecoveryDeliveryRunId;
      expect(runId && getRpcSource(runId)).toBeTruthy();
    },
    { timeout: 30_000 },
  );
  return { runId: runId!, source: getRpcSource(runId!)! };
}

/** Holds a session's Gateway admission, so a resend waits after winning its durable attempt. */
async function holdSessionAdmission(fixture: Fixture, sessionKey: string, sessionId: string) {
  const release = createDeferred();
  const started = createDeferred();
  const mutation = runSessionMutation({
    scope: fixture.storePath,
    identities: [sessionKey, sessionId],
    run: async () => {
      started.resolve();
      await release.promise;
    },
  });
  await started.promise;
  return async () => {
    release.resolve();
    await mutation;
  };
}

/** Waits until startup has prepared a resend for the session and reserved its input. */
async function waitForPreparedResend(fixture: Fixture, sessionKey: string, previousRunId?: string) {
  await vi.waitFor(
    () => {
      const runId = readEntry(fixture, sessionKey)?.restartRecoveryDeliveryRunId;
      expect(runId).toBeDefined();
      expect(runId).not.toBe(previousRunId);
      expect(getRpcSource(runId!) ?? getReservedRpcSourceInput(runId!)).toBeDefined();
    },
    { timeout: 30_000 },
  );
  // Gateway admission has not consumed the interruption marker yet.
  expect(readEntry(fixture, sessionKey)).toMatchObject({
    abortedLastRun: true,
    status: "interrupted",
  });
}

/** Waits until a chat turn has reached the model once and released its controller source. */
async function waitForChatTurn(runId: string, text: string) {
  await vi.waitFor(
    () => {
      expect(promptTurns(text)).toHaveLength(1);
      expect(getRpcSource(runId)).toBeUndefined();
    },
    { timeout: 30_000 },
  );
}

async function owedResendRunsBeforeFirstChatSend(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-first-send";
  const sessionId = "boundary-first-send-session";
  const owed = "First-send case: owed interrupted task.";
  const user = "First-send case: message that arrives during startup.";
  await seedInterruptedSession(fixture, { sessionKey, sessionId, message: owed });
  const runId = "boundary-first-send-user";
  await expect(
    fixture.client.request("chat.send", {
      sessionKey,
      sessionId,
      message: user,
      deliver: false,
      idempotencyKey: runId,
    }),
  ).resolves.toMatchObject({ runId, status: "started" });
  await waitForChatTurn(runId, user);
  // The startup scan that follows finds nothing left to resend.
  await expect(runStartupRecovery(fixture)).resolves.toMatchObject({ started: 0, failed: 0 });
  const turns = requests.filter((body) => body.includes(owed));
  expect(turns.map((body) => activePrompt(body).includes(RESEND_MARKER))).toEqual([true, false]);
  expect(activePrompt(turns[1] ?? "")).toContain(user);
  expect(readEntry(fixture, sessionKey)).toMatchObject({ status: "done", abortedLastRun: false });
}

async function owedResendRunsBeforeChatSendDuringItsAdmission(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-send-during-resend";
  const sessionId = "boundary-send-during-resend-session";
  const owed = "In-flight case: owed interrupted task.";
  const user = "In-flight case: message that arrives while the resend is admitted.";
  await seedInterruptedSession(fixture, { sessionKey, sessionId, message: owed });
  const releaseAdmission = await holdSessionAdmission(fixture, sessionKey, sessionId);
  let recovery: ReturnType<typeof runStartupRecovery> | undefined;
  let send: Promise<unknown> | undefined;
  const runId = "boundary-send-during-resend-user";
  try {
    recovery = runStartupRecovery(fixture);
    await waitForPreparedResend(fixture, sessionKey);
    send = fixture.client.request("chat.send", {
      sessionKey,
      sessionId,
      message: user,
      deliver: false,
      idempotencyKey: runId,
    });
  } finally {
    await releaseAdmission();
  }
  await expect(send).resolves.toMatchObject({ runId, status: "started" });
  await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
  // The message waits behind the resend input and runs once that turn settles.
  await waitForChatTurn(runId, user);
  expect(resendTurns(owed)).toHaveLength(1);
  expect(requests.indexOf(resendTurns(owed)[0]!)).toBeLessThan(
    requests.indexOf(promptTurns(user)[0]!),
  );
}

async function sameIdRetryJoinsPreparedResend(fixture: Fixture) {
  const sessionKey = "agent:main:dashboard:boundary-retry";
  const sessionId = "boundary-retry-session";
  const owed = "Retry case: accepted chat turn interrupted by restart.";
  const sourceRunId = "boundary-retry-source";
  await seedInterruptedSession(fixture, {
    sessionKey,
    sessionId,
    message: owed,
    patch: {
      restartRecoveryDeliveryRunId: sourceRunId,
      restartRecoveryDeliverySourceRunId: sourceRunId,
      restartRecoveryDeliveryRequestFingerprint: (
        await chatRestartRecovery.createRestartSafeChatRequest({
          cfg: fixture.cfg,
          eligible: true,
          message: owed,
          senderIsOwner: true,
        })
      )?.fingerprint,
      restartRecoverySourceIngress: "control-ui",
    },
  });
  const releaseAdmission = await holdSessionAdmission(fixture, sessionKey, sessionId);
  let recovery: ReturnType<typeof runStartupRecovery> | undefined;
  try {
    recovery = runStartupRecovery(fixture);
    await waitForPreparedResend(fixture, sessionKey, sourceRunId);
    // The retry joins the owed resend instead of dispatching or reporting "pending; retry".
    await expect(
      fixture.client.request("chat.send", {
        sessionKey,
        sessionId,
        message: owed,
        deliver: false,
        idempotencyKey: sourceRunId,
      }),
    ).resolves.toMatchObject({ runId: sourceRunId, status: "ok" });
  } finally {
    await releaseAdmission();
  }
  await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
  await vi.waitFor(() => expect(readEntry(fixture, sessionKey)?.status).toBe("done"), {
    timeout: 30_000,
  });
  expect(resendTurns(owed)).toHaveLength(1);
}

async function stopCancelsWaitingResend(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-stop";
  const sessionId = "boundary-stop-session";
  const owed = "Stop case: owed interrupted task.";
  await seedInterruptedSession(fixture, { sessionKey, sessionId, message: owed });
  const releaseAdmission = await holdSessionAdmission(fixture, sessionKey, sessionId);
  const releaseLane = holdRecoveryLane(sessionKey);
  const recovery = runStartupRecovery(fixture);
  let runId: string;
  try {
    const resend = await waitForResendSource(fixture, sessionKey);
    runId = resend.runId;
    expect(resendTurns(owed)).toHaveLength(0);
    await expect(
      fixture.client.request("sessions.abort", { key: sessionKey }),
    ).resolves.toMatchObject({ abortedRunId: runId, status: "aborted" });
    expect(resend.source.input.abortSignal.aborted).toBe(true);
  } finally {
    await releaseAdmission();
    releaseLane();
  }
  await expect(recovery).resolves.toMatchObject({ started: 0, settled: 1, failed: 0 });
  const cancelled = await fixture.client.request("agent.wait", { runId, timeoutMs: 0 });
  expect(cancelled).toMatchObject({
    status: "error",
    stopReason: "rpc",
    providerStarted: false,
  });
  // The lifecycle observation records RPC cancellation without attributing a timeout phase.
  expect(cancelled).not.toHaveProperty("timeoutPhase");
  // The cancelled resend is recorded as a stopped run: not owed again and not charged.
  const stopped = readEntry(fixture, sessionKey);
  expect(stopped?.status).toBe("killed");
  expect(stopped?.mainRestartRecovery).toBeUndefined();
  expect(stopped?.restartRecoveryTerminalRunIds).toContain(runId);
  await expect(runStartupRecovery(fixture)).resolves.toMatchObject({ started: 0, failed: 0 });
  expect(resendTurns(owed)).toHaveLength(0);
}

async function interruptWinsOverOwedResend(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-interrupt-owed";
  const sessionId = "boundary-interrupt-owed-session";
  const owed = "Owed-interrupt case: owed interrupted task.";
  const user = "Owed-interrupt case: newest message.";
  await seedInterruptedSession(fixture, { sessionKey, sessionId, message: owed });
  const runId = "boundary-interrupt-owed-user";
  await expect(
    fixture.client.request("chat.send", {
      sessionKey,
      sessionId,
      message: user,
      deliver: false,
      queueMode: "interrupt",
      idempotencyKey: runId,
    }),
  ).resolves.toMatchObject({ runId, status: "started" });
  // The interrupt wins: the user's message runs and the owed resend is dropped, not replayed.
  await waitForChatTurn(runId, user);
  await vi.waitFor(() => expect(readEntry(fixture, sessionKey)?.status).toBe("done"), {
    timeout: 30_000,
  });
  expect(readEntry(fixture, sessionKey)).toMatchObject({ abortedLastRun: false });
  expect(readEntry(fixture, sessionKey)?.mainRestartRecovery).toBeUndefined();
  await expect(runStartupRecovery(fixture)).resolves.toMatchObject({ started: 0, failed: 0 });
  expect(resendTurns(owed)).toHaveLength(0);
}

async function interruptCancelsWaitingResend(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-interrupt-waiting";
  const sessionId = "boundary-interrupt-waiting-session";
  const owed = "Waiting-interrupt case: owed interrupted task.";
  const user = "Waiting-interrupt case: newest message.";
  await seedInterruptedSession(fixture, { sessionKey, sessionId, message: owed });
  const releaseLane = holdRecoveryLane(sessionKey);
  const recovery = runStartupRecovery(fixture);
  let resendRunId: string;
  const runId = "boundary-interrupt-waiting-user";
  try {
    ({ runId: resendRunId } = await waitForResendSource(fixture, sessionKey));
    expect(resendTurns(owed)).toHaveLength(0);
    await expect(
      fixture.client.request("chat.send", {
        sessionKey,
        sessionId,
        message: user,
        deliver: false,
        queueMode: "interrupt",
        idempotencyKey: runId,
      }),
    ).resolves.toMatchObject({ runId, interruptedActiveRun: true });
  } finally {
    releaseLane();
  }
  // The dispatcher reports the stopped resend as settled, not as a failed attempt.
  await expect(recovery).resolves.toMatchObject({ started: 0, settled: 1, failed: 0 });
  await waitForChatTurn(runId, user);
  const settled = readEntry(fixture, sessionKey);
  expect(settled?.mainRestartRecovery).toBeUndefined();
  expect(settled?.restartRecoveryTerminalRunIds).toContain(resendRunId);
  await expect(runStartupRecovery(fixture)).resolves.toMatchObject({ started: 0, failed: 0 });
  expect(resendTurns(owed)).toHaveLength(0);
}

async function interruptEndsRunningResend(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-interrupt-running";
  const sessionId = "boundary-interrupt-running-session";
  const owed = "Running-interrupt case: owed interrupted task.";
  const user = "Running-interrupt case: newest message.";
  await seedInterruptedSession(fixture, { sessionKey, sessionId, message: owed });
  const release = holdProvider(owed);
  const recovery = runStartupRecovery(fixture);
  await vi.waitFor(() => expect(resendTurns(owed)).toHaveLength(1), { timeout: 30_000 });
  // The executing resend already counts as started, so it owes no further attempt.
  expect(readEntry(fixture, sessionKey)?.mainRestartRecovery).toMatchObject({
    chargedAttempts: 1,
    startedAttempt: 1,
  });
  const runId = "boundary-interrupt-running-user";
  await expect(
    fixture.client.request("chat.send", {
      sessionKey,
      sessionId,
      message: user,
      deliver: false,
      queueMode: "interrupt",
      idempotencyKey: runId,
    }),
  ).resolves.toMatchObject({ runId, interruptedActiveRun: true });
  release();
  await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
  await waitForChatTurn(runId, user);
  expect(readEntry(fixture, sessionKey)?.mainRestartRecovery).toBeUndefined();
  await expect(runStartupRecovery(fixture)).resolves.toMatchObject({ started: 0, failed: 0 });
  expect(resendTurns(owed)).toHaveLength(1);
}

async function interruptSurvivesInterruptedTurnCleanup(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-interrupt-cleanup";
  const sessionId = "boundary-interrupt-cleanup-session";
  const owed = "Cleanup-interrupt case: owed interrupted task.";
  const user = "Cleanup-interrupt case: newest message.";
  await seedInterruptedSession(fixture, { sessionKey, sessionId, message: owed });
  const release = holdProvider(owed);
  const recovery = runStartupRecovery(fixture);
  await vi.waitFor(() => expect(resendTurns(owed)).toHaveLength(1), { timeout: 30_000 });
  // Admission performs Stop only after its authority checks. Hold the handoff to
  // dispatch until the real interrupted owner releases its placement claim.
  const admit = chatAdmission.admitChatSend;
  const admissionGate = vi
    .spyOn(chatAdmission, "admitChatSend")
    .mockImplementationOnce(async (params) => {
      const admitted = await admit(params);
      expect(admitted.ok).toBe(true);
      if (admitted.ok) {
        expect(admitted.value.interruptedActiveRun).toBe(true);
        await chatRestartRecovery.withRestartSafeChatPlacement(
          expectDefined(params.context.workerSessionPlacementService, "placement owner"),
          admitted.value.admittedSessionId,
          async (prepared) => {
            await vi.waitFor(
              async () => {
                await prepared.facts.prepareRead();
                expect(prepared.facts.current()).toMatchObject({ turnClaim: null });
              },
              { timeout: 30_000 },
            );
          },
        );
      }
      return admitted;
    });
  const runId = "boundary-interrupt-cleanup-user";
  try {
    await expect(
      fixture.client.request("chat.send", {
        sessionKey,
        sessionId,
        message: user,
        deliver: false,
        queueMode: "interrupt",
        idempotencyKey: runId,
      }),
    ).resolves.toMatchObject({ runId, status: "started", interruptedActiveRun: true });
    expect(admissionGate).toHaveBeenCalledOnce();
  } finally {
    admissionGate.mockRestore();
    release();
  }
  await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
  await waitForChatTurn(runId, user);
  await expect(runStartupRecovery(fixture)).resolves.toMatchObject({ started: 0, failed: 0 });
  // The user's message ran exactly once and the interrupted resend is not replayed.
  expect(promptTurns(user)).toHaveLength(1);
  expect(resendTurns(owed)).toHaveLength(1);
}

async function steerQueuesBehindRestartSafeResend(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-steer";
  const sessionId = "boundary-steer-session";
  const owed = "Steer case: owed interrupted task.";
  const steer = "Steer case: message for the recovery turn.";
  // An unresolved final reply forces the resend onto replay-safe tools.
  await seedInterruptedSession(fixture, {
    sessionKey,
    sessionId,
    message: owed,
    patch: {
      pendingFinalDelivery: { kind: "transport-only", createdAt: Date.now() },
      restartRecoveryRuns: [
        { runId: "boundary-steer-interrupted", lifecycleGeneration: "previous-gateway" },
      ],
    },
  });
  const release = holdProvider(owed);
  const recovery = runStartupRecovery(fixture);
  await vi.waitFor(() => expect(resendTurns(owed)).toHaveLength(1), { timeout: 30_000 });
  expect(activePrompt(resendTurns(owed)[0] ?? "")).toContain("narrowed to replay-safe tools");
  const runId = "boundary-steer-user";
  await expect(
    fixture.client.request("chat.send", {
      sessionKey,
      sessionId,
      message: steer,
      deliver: false,
      queueMode: "steer",
      idempotencyKey: runId,
    }),
  ).resolves.toMatchObject({ runId, status: "started" });
  release();
  await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
  await waitForChatTurn(runId, steer);
  // The steer ran as its own later turn; the recovery turn never saw it.
  expect(resendTurns(owed)).toHaveLength(1);
  expect(resendTurns(owed)[0]).not.toContain(steer);
}

// The test runtime resets plugin state after each test, so one test owns the Gateway.
it("orders, joins, and cancels restart resends through the session mailbox", async () => {
  const token = "startup-recovery-boundary-token";
  const state = await createOpenClawTestState({
    label: "startup-recovery-boundary",
    env: {
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  let responseCount = 0;
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body.includes("Generate a concise session title")) {
        requests.push(body);
        for (const [text, gate] of holds) {
          if (body.includes(text)) {
            await gate.promise;
          }
        }
      }
      responseCount += 1;
      writeOpenAiResponsesText(response, {
        text: "BOUNDARY_OK",
        messageId: `boundary-${responseCount}`,
        responseId: `boundary-response-${responseCount}`,
      });
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("boundary provider did not bind");
    }
    const model = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "gpt-startup-recovery-boundary",
    );
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          maxConcurrent: 1,
          model: { primary: model.modelRef },
          models: { [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
        },
        entries: { main: {} },
      },
      messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
      models: { mode: "replace", providers: { [model.providerId]: model.config } },
      gateway: {
        auth: { mode: "token", token },
        controlUi: { allowedOrigins: ["http://localhost:18789"] },
      },
      plugins: { slots: { memory: "none" } },
    } satisfies OpenClawConfig;
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: "http://localhost:18789",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    await gateway.server.startupSettled;
    const fixture: Fixture = {
      cfg,
      client: gateway.client,
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      workspaceDir: state.workspaceDir,
      stateDir: state.stateDir,
    };
    const warmupRunId = "boundary-warmup";
    await fixture.client.request("agent", {
      sessionKey: `agent:main:${warmupRunId}`,
      message: "Warm the agent runtime.",
      deliver: false,
      idempotencyKey: warmupRunId,
    });
    await expect(
      fixture.client.request("agent.wait", { runId: warmupRunId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });

    await owedResendRunsBeforeFirstChatSend(fixture);
    await owedResendRunsBeforeChatSendDuringItsAdmission(fixture);
    await sameIdRetryJoinsPreparedResend(fixture);
    await stopCancelsWaitingResend(fixture);
    await interruptWinsOverOwedResend(fixture);
    await interruptCancelsWaitingResend(fixture);
    await interruptEndsRunningResend(fixture);
    await interruptSurvivesInterruptedTurnCleanup(fixture);
    await steerQueuesBehindRestartSafeResend(fixture);
  } finally {
    for (const gate of holds.values()) {
      gate.resolve();
    }
    if (gateway) {
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close().catch(() => undefined);
    }
    if (provider.listening) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => {
        provider.close(() => resolve());
      });
    }
    await state.cleanup();
  }
}, 180_000);
