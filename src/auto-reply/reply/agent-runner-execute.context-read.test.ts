import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { acquireSessionInputActor } from "../../config/sessions/session-input-actor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runBeforeAgentReplyForTurn } from "../../plugins/before-agent-reply.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { executePreparedReplyAgentRun } from "./agent-runner-execute.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createMockReplyOperation, createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

// mock-isolation: Isolate model execution, compaction, delivery, and plugins; retain queue/transcript admission.
vi.mock("./agent-runner-execution.js", () => ({ executeAgentTurn: vi.fn() }));
// mock-isolation: Compaction is outside this source-admission race.
vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: async (params: { sessionEntry: InternalSessionEntry }) =>
    params.sessionEntry,
}));
// mock-isolation: No follow-up or outbound delivery is started by this admission fixture.
vi.mock("./followup-runner.js", () => ({ createFollowupRunner: () => async () => {} }));
// mock-isolation: The test ends after the runtime-owned transcript and reply boundary.
vi.mock("./agent-runner-result.js", () => ({ finalizeReplyAgentRun: async () => undefined }));
// mock-isolation: Verify admission even when no plugin hook is registered.
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => undefined }));

it("keeps a cron context prefix readable when an inbound turn persists before queuing", async () => {
  await withOpenClawTestState({ label: "cron-inbound-context-read" }, async (state) => {
    setRuntimeConfigSnapshot({});
    onTestFinished(() => clearRuntimeConfigSnapshot());
    const target = {
      agentId: "main",
      sessionId: "cron-session",
      sessionKey: "agent:main:main",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    let entry: InternalSessionEntry = { sessionId: target.sessionId, updatedAt: 1 };
    const sourceTurnId = "channel-user:v1:synthetic-dm";
    await replaceSessionEntry(target, entry);
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync({ role: "user", content: "prior turn", timestamp: 1 });
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "incoming DM", idempotencyKey: sourceTurnId },
      target: { ...target, sessionEntry: entry },
    });
    const inputAbort = new AbortController();
    const assertInputCurrent = () => inputAbort.signal.throwIfAborted();
    const acquiredInput = await acquireSessionInputActor(
      {
        ...target,
        target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      },
      { assertCurrent: assertInputCurrent, assertReadable: assertInputCurrent },
    );
    if (!acquiredInput) {
      throw new Error("Inbound request did not acquire its session input actor");
    }
    await using input = {
      ...acquiredInput,
      async [Symbol.asyncDispose]() {
        inputAbort.abort();
        await acquiredInput.actor.release();
      },
    };
    const recovery = createReplyRestartRecoveryClaimController({
      ...target,
      acquireSessionActor: async () => input,
      admissionRunId: "inbound-run",
      sourceTurnId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      getEntry: () => entry,
      getSessionId: () => target.sessionId,
      setEntry: (next) => {
        entry = next;
      },
      isRestartAbort: () => false,
      resolveDeliveryContext: () => ({ channel: "telegram", to: "synthetic-chat" }),
    });
    const reading = createDeferred();
    const releaseRead = createDeferred();
    const queued = createDeferred();
    const cron = withSessionTurn(target, () =>
      SessionManager.readSessionContextAsync(target, async (messages) => {
        const snapshot = [...messages];
        reading.resolve();
        await releaseRead.promise;
        return snapshot;
      }),
    );
    await awaitGateBeforeSettlement(reading.promise, cron, "cron did not start reading context");
    const adopted = vi.fn();
    const inboundStarted = vi.fn();
    vi.mocked(executeAgentTurn).mockImplementation((params) => {
      const pending = withSessionTurn<Awaited<ReturnType<typeof executeAgentTurn>>>(
        { ...target, abortSignal: params.replyOperation?.abortSignal },
        async () => {
          inboundStarted();
          await runBeforeAgentReplyForTurn({
            runId: "inbound-runtime",
            trigger: "user",
            event: { cleanedBody: "incoming DM" },
            context: { sessionKey: target.sessionKey },
          });
          expect(recorder.hasPersisted()).toBe(true);
          expect(adopted).toHaveBeenCalledOnce();
          return {
            runId: "inbound-runtime",
            outcome: {
              kind: "settled",
              status: "ok",
              result: { meta: { durationMs: 0 } },
              resolved: { provider: "test", model: "test" },
              fallback: { exhausted: false, attempts: [] },
              autoCompactionCount: 0,
            },
          };
        },
      );
      queued.resolve();
      return pending;
    });
    const typing = createMockTypingController();
    const followupRun = createTestFollowupRun(target);
    followupRun.userTurnTranscriptRecorder = recorder;
    followupRun.turnAdoptionLifecycle = { onAdopted: adopted };
    const { replyOperation } = createMockReplyOperation({
      key: target.sessionKey,
      sessionId: target.sessionId,
    });
    const inbound = executePreparedReplyAgentRun({
      ...target,
      ...recovery,
      followupRun,
      replyOperation,
      typing,
      activeIsNewSession: false,
      activeSessionStore: undefined,
      cfg: {},
      commandBody: "incoming DM",
      defaultModel: "test",
      isHeartbeat: false,
      queueKey: target.sessionKey,
      resolvedQueue: { mode: "followup" },
      sessionCtx: { Provider: "telegram" },
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      resolvedVerboseLevel: "off",
      shouldInjectGroupIntro: false,
      pendingToolTasks: new Set(),
      preflightCompactionApplied: false,
      replyMediaContext: { normalizePayload: async (payload) => payload },
      replyRouteThreadId: undefined,
      replyToChannel: "telegram",
      replyToMode: "off",
      typingMode: "never",
      typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
      applyReplyToMode: (payload) => payload,
      getActiveSessionEntry: () => entry,
      isRestartRecoveryArmed: recovery.isArmed,
      onCompactionNoticePayload: () => {},
      resolveVisibleReplyDelivery: async () => false,
      returnWithQueuedFollowupDrain: (value) => value,
      setRunFollowupTurn: () => {},
      runFollowupTurn: async () => {},
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => false,
      traceAgentPhase: async (_name, run) => await run(),
    });
    try {
      await awaitGateBeforeSettlement(queued.promise, inbound, "inbound did not queue");
      expect(recorder.hasPersisted()).toBe(true);
      expect(inboundStarted).not.toHaveBeenCalled();
      releaseRead.resolve();
      await expect(cron).resolves.toMatchObject([{ role: "user", content: "prior turn" }]);
      await inbound;
      expect(inboundStarted).toHaveBeenCalledOnce();
      const messages = await SessionManager.readSessionContextAsync(target, (rows) => [...rows]);
      expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
      expect(loadSessionEntry(target)?.restartRecoveryDeliverySourceRunId).toBe(sourceTurnId);
    } finally {
      releaseRead.resolve();
      await Promise.allSettled([cron, inbound]);
    }
  });
});
