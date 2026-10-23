import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import type { SessionsRecoverResult } from "../../packages/gateway-protocol/src/index.js";
import { closeHttpServer } from "../../test/helpers/gateway-integration-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCommandLaneSnapshot, setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import {
  getReservedRpcSourceInput,
  getRpcSource,
} from "../sessions/session-controller.rpc-sources.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import * as agentContent from "./agent-turn/agent-content-phase.js";
import * as chatRestartRecovery from "./server-methods/chat-restart-recovery.js";
import * as chatAdmission from "./server-methods/chat-send-admission.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { createStartupRecoveryFixture } from "./server.startup-recovery.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

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

function sendChat(
  fixture: Fixture,
  sessionKey: string,
  sessionId: string,
  message: string,
  runId: string,
  queueMode?: "interrupt" | "steer",
) {
  return fixture.client.request("chat.send", {
    sessionKey,
    sessionId,
    message,
    deliver: false,
    idempotencyKey: runId,
    queueMode,
  });
}

/** Seeds a main session exactly as a Gateway restart leaves an interrupted turn. */
async function seedInterruptedSession(
  fixture: Fixture,
  params: {
    sessionKey: string;
    sessionId: string;
    message: string;
    provenance?: InputProvenance;
    patch?: Partial<InternalSessionEntry>;
  },
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
        provenance: params.provenance,
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

function expectRecovery(fixture: Fixture, started = 0, settled?: number) {
  return expect(runStartupRecovery(fixture)).resolves.toMatchObject({
    started,
    failed: 0,
    ...(settled === undefined ? {} : { settled }),
  });
}

async function seedCase(fixture: Fixture, name: string, patch?: Partial<InternalSessionEntry>) {
  const sessionKey = `agent:main:boundary-${name}`;
  const sessionId = `boundary-${name}-session`;
  const owed = `${name}: interrupted task.`;
  await seedInterruptedSession(fixture, {
    sessionKey,
    sessionId,
    message: owed,
    patch,
  });
  return {
    sessionKey,
    sessionId,
    owed,
    user: `${name}: newest message.`,
    runId: `boundary-${name}-user`,
  };
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

async function unavailableDelegatedTurnLeavesConversationUsable(fixture: Fixture) {
  const sessionKey = "agent:main:boundary-delegated";
  const sessionId = "boundary-delegated-session";
  const interruptedRunId = "boundary-delegated-old";
  const delegated = "Delegated case: interrupted update.";
  await seedInterruptedSession(fixture, {
    sessionKey,
    sessionId,
    message: delegated,
    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    patch: {
      restartRecoveryDeliverySourceRunId: interruptedRunId,
      restartRecoveryRuns: [{ runId: interruptedRunId, lifecycleGeneration: "old-gateway" }],
    },
  });
  await expectRecovery(fixture, 0, 1);
  expect(promptTurns(delegated)).toHaveLength(0);
  const interrupted = readEntry(fixture, sessionKey);
  expect(interrupted).toMatchObject({
    sessionId,
    status: "interrupted",
    abortedLastRun: false,
  });
  expect(interrupted?.mainRestartRecovery).toBeUndefined();
  expect(interrupted?.restartRecoveryTerminalRunIds).toContain(interruptedRunId);
  await expectRecovery(fixture, 0, 0);

  const user = "Delegated case: fresh authenticated request.";
  const runId = "boundary-delegated-new";
  await expect(sendChat(fixture, sessionKey, sessionId, user, runId)).resolves.toMatchObject({
    runId,
    status: "started",
  });
  await waitForChatTurn(runId, user);
  expect(readEntry(fixture, sessionKey)).toMatchObject({
    sessionId,
    status: "done",
    abortedLastRun: false,
  });
  expect(resendTurns(delegated)).toHaveLength(0);
}

async function owedResendRunsBeforeFirstChatSend(fixture: Fixture) {
  const { sessionKey, sessionId, owed, user, runId } = await seedCase(fixture, "first-send");
  await expect(sendChat(fixture, sessionKey, sessionId, user, runId)).resolves.toMatchObject({
    runId,
    status: "started",
  });
  await waitForChatTurn(runId, user);
  // The startup scan that follows finds nothing left to resend.
  await expectRecovery(fixture);
  const turns = requests.filter((body) => body.includes(owed));
  expect(turns.map((body) => activePrompt(body).includes(RESEND_MARKER))).toEqual([true, false]);
  expect(activePrompt(turns[1] ?? "")).toContain(user);
  expect(readEntry(fixture, sessionKey)).toMatchObject({ status: "done", abortedLastRun: false });
}

async function owedResendRunsBeforeChatSendDuringItsAdmission(fixture: Fixture) {
  const { sessionKey, sessionId, owed, user, runId } = await seedCase(
    fixture,
    "send-during-resend",
  );
  const releaseAdmission = await holdSessionAdmission(fixture, sessionKey, sessionId);
  let recovery: ReturnType<typeof runStartupRecovery> | undefined;
  let send: Promise<unknown> | undefined;
  try {
    recovery = runStartupRecovery(fixture);
    await waitForPreparedResend(fixture, sessionKey);
    send = sendChat(fixture, sessionKey, sessionId, user, runId);
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
      sendChat(fixture, sessionKey, sessionId, owed, sourceRunId),
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
  const { sessionKey, sessionId, owed } = await seedCase(fixture, "stop");
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
  await expectRecovery(fixture);
  expect(resendTurns(owed)).toHaveLength(0);
}

async function interruptWinsOverOwedResend(fixture: Fixture) {
  const { sessionKey, sessionId, owed, user, runId } = await seedCase(fixture, "interrupt-owed");
  await expect(
    sendChat(fixture, sessionKey, sessionId, user, runId, "interrupt"),
  ).resolves.toMatchObject({ runId, status: "started" });
  // The interrupt wins: the user's message runs and the owed resend is dropped, not replayed.
  await waitForChatTurn(runId, user);
  await vi.waitFor(() => expect(readEntry(fixture, sessionKey)?.status).toBe("done"), {
    timeout: 30_000,
  });
  expect(readEntry(fixture, sessionKey)?.abortedLastRun).toBe(false);
  expect(readEntry(fixture, sessionKey)?.mainRestartRecovery).toBeUndefined();
  await expectRecovery(fixture);
  expect(resendTurns(owed)).toHaveLength(0);
}

async function interruptCancelsWaitingResend(fixture: Fixture, signal: AbortSignal) {
  const { sessionKey, sessionId, owed, user, runId } = await seedCase(fixture, "interrupt-waiting");
  const releaseLane = holdRecoveryLane(sessionKey);
  const preparing = createDeferred();
  const releasePreparation = createDeferred();
  const prepare = agentContent.prepareAgentContentPhase;
  // Interrupt after source registration, before the later admission revalidator
  // can publish cancellation on behalf of unfinished preparation.
  const held = vi
    .spyOn(agentContent, "prepareAgentContentPhase")
    .mockImplementationOnce(async (params) => {
      const content = await prepare(params);
      preparing.resolve();
      await releasePreparation.promise;
      return content;
    });
  const recovery = runStartupRecovery(fixture);
  let resendRunId: string;
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        preparing.promise,
        recovery,
        "Restart resend ended before content preparation",
      ),
      signal,
    );
    resendRunId = expectDefined(
      readEntry(fixture, sessionKey)?.restartRecoveryDeliveryRunId,
      "prepared restart resend",
    );
    const source = expectDefined(getRpcSource(resendRunId), "registered restart resend");
    expect(resendTurns(owed)).toHaveLength(0);
    await expect(
      sendChat(fixture, sessionKey, sessionId, user, runId, "interrupt"),
    ).resolves.toMatchObject({ runId, interruptedActiveRun: true });
    expect(source.input.abortSignal.aborted).toBe(true);
  } finally {
    releasePreparation.resolve();
    held.mockRestore();
    releaseLane();
  }
  // The dispatcher reports the stopped resend as settled, not as a failed attempt.
  await expect(recovery).resolves.toMatchObject({ started: 0, settled: 1, failed: 0 });
  await waitForChatTurn(runId, user);
  const settled = readEntry(fixture, sessionKey);
  expect(settled?.mainRestartRecovery).toBeUndefined();
  expect(settled?.restartRecoveryTerminalRunIds).toContain(resendRunId);
  await expectRecovery(fixture);
  expect(resendTurns(owed)).toHaveLength(0);
}

async function interruptSurvivesInterruptedTurnCleanup(fixture: Fixture) {
  const { sessionKey, sessionId, owed, user, runId } = await seedCase(fixture, "interrupt-cleanup");
  const release = holdProvider(owed);
  const recovery = runStartupRecovery(fixture);
  await vi.waitFor(() => expect(resendTurns(owed)).toHaveLength(1), { timeout: 30_000 });
  expect(readEntry(fixture, sessionKey)?.mainRestartRecovery).toMatchObject({
    chargedAttempts: 1,
    startedAttempt: 1,
  });
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
  try {
    await expect(
      sendChat(fixture, sessionKey, sessionId, user, runId, "interrupt"),
    ).resolves.toMatchObject({ runId, status: "started", interruptedActiveRun: true });
    expect(admissionGate).toHaveBeenCalledOnce();
  } finally {
    admissionGate.mockRestore();
    release();
  }
  await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
  await waitForChatTurn(runId, user);
  expect(readEntry(fixture, sessionKey)?.mainRestartRecovery).toBeUndefined();
  await expectRecovery(fixture);
  // The user's message ran exactly once and the interrupted resend is not replayed.
  expect(promptTurns(user)).toHaveLength(1);
  expect(resendTurns(owed)).toHaveLength(1);
}

async function steerQueuesBehindRestartSafeResend(fixture: Fixture) {
  // An unresolved final reply forces the resend onto replay-safe tools.
  const { sessionKey, sessionId, owed, user, runId } = await seedCase(fixture, "steer", {
    pendingFinalDelivery: { kind: "transport-only", createdAt: Date.now() },
    restartRecoveryRuns: [
      { runId: "boundary-steer-interrupted", lifecycleGeneration: "previous-gateway" },
    ],
  });
  const release = holdProvider(owed);
  const recovery = runStartupRecovery(fixture);
  await vi.waitFor(() => expect(resendTurns(owed)).toHaveLength(1), { timeout: 30_000 });
  expect(activePrompt(resendTurns(owed)[0] ?? "")).toContain("narrowed to replay-safe tools");
  await expect(
    sendChat(fixture, sessionKey, sessionId, user, runId, "steer"),
  ).resolves.toMatchObject({ runId, status: "started" });
  release();
  await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
  await waitForChatTurn(runId, user);
  // The steer ran as its own later turn; the recovery turn never saw it.
  expect(resendTurns(owed)).toHaveLength(1);
  expect(resendTurns(owed)[0]).not.toContain(user);
}

async function resetRestoresMainAfterRecoveryArchival(fixture: Fixture) {
  const sessionKey = "agent:main:main";
  const sessionId = "boundary-archived-main";
  const owed = "Archived Main case: interrupted task retained in history.";
  const fresh = "Archived Main case: fresh task after explicit reset.";
  const target = { agentId: "main", storePath: fixture.storePath, sessionKey, sessionId };
  await seedInterruptedSession(fixture, {
    sessionKey,
    sessionId,
    message: owed,
    patch: {
      mainRestartRecovery: { cycleId: sessionId, revision: 1, chargedAttempts: 3 },
    },
  });
  // Run the real startup owner from persisted restart state, then use the public recovery API.
  await expectRecovery(fixture);
  expect(readEntry(fixture, sessionKey)?.mainRestartRecovery?.tombstone).toBeDefined();
  const recovered = await fixture.client.request<SessionsRecoverResult>("sessions.recover", {
    key: sessionKey,
    mode: "new-session",
  });
  expect(recovered.key).not.toBe(sessionKey);
  expect(recovered.continuation.status).toBe("started");
  if (recovered.continuation.status === "started") {
    await expect(
      fixture.client.request("agent.wait", {
        runId: recovered.continuation.runId,
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({ status: "ok" });
  }
  expect(readEntry(fixture, sessionKey)).toMatchObject({
    sessionId,
    archivedAt: expect.any(Number),
    archiveReason: "restart-recovery",
  });
  const retained = await loadTranscriptEvents(target);
  await expect(
    fixture.client.request("sessions.reset", { key: sessionKey, expectedSessionId: sessionId }),
  ).resolves.toMatchObject({ ok: true });
  const reset = readEntry(fixture, sessionKey);
  expect(reset?.sessionId).toBe(sessionId);
  expect(reset?.archivedAt).toBeUndefined();
  expect(reset?.mainRestartRecovery).toBeUndefined();
  const afterReset = await loadTranscriptEvents(target);
  expect(afterReset.slice(0, retained.length)).toEqual(retained);
  expect(afterReset.slice(retained.length)).toContainEqual(
    expect.objectContaining({ type: "reset", reason: "reset" }),
  );
  const runId = "boundary-archived-main-fresh";
  await sendChat(fixture, sessionKey, sessionId, fresh, runId);
  await waitForChatTurn(runId, fresh);
  expect(promptTurns(fresh)[0]).not.toContain(owed);
}

// The test runtime resets plugin state after each test, so one test owns the Gateway.
it("orders, joins, and cancels restart resends through the session mailbox", async ({ signal }) => {
  const { state, provider, cfg, token } = await createStartupRecoveryFixture(
    "startup-recovery-boundary",
    async (body) => {
      requests.push(body);
      for (const [text, gate] of holds) {
        if (body.includes(text)) {
          await gate.promise;
        }
      }
    },
    { maxConcurrent: 1, responseText: "BOUNDARY_OK", controlUi: true },
  );
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
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

    await unavailableDelegatedTurnLeavesConversationUsable(fixture);
    await owedResendRunsBeforeFirstChatSend(fixture);
    await owedResendRunsBeforeChatSendDuringItsAdmission(fixture);
    await sameIdRetryJoinsPreparedResend(fixture);
    await stopCancelsWaitingResend(fixture);
    await interruptWinsOverOwedResend(fixture);
    await interruptCancelsWaitingResend(fixture, signal);
    await interruptSurvivesInterruptedTurnCleanup(fixture);
    await steerQueuesBehindRestartSafeResend(fixture);
    await resetRestoresMainAfterRecoveryArchival(fixture);
  } finally {
    for (const gate of holds.values()) {
      gate.resolve();
    }
    if (gateway) {
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close().catch(() => undefined);
    }
    if (provider.listening) {
      await closeHttpServer(provider);
    }
    await state.cleanup();
  }
}, 180_000);
