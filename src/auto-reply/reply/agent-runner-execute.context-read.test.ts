import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runBeforeAgentReplyForTurn } from "../../plugins/before-agent-reply.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { executePreparedReplyAgentRun } from "./agent-runner-execute.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";
import { createMockReplyOperation, createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

// mock-isolation: The fixture replaces model execution with the real session queue and reply boundary.
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
    const target = {
      agentId: "main",
      sessionId: "cron-session",
      sessionKey: "agent:main:main",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    let entry: InternalSessionEntry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync({ role: "user", content: "prior turn", timestamp: 1 });
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "incoming DM", idempotencyKey: "channel-user:v1:synthetic-dm" },
      target: { ...target, sessionEntry: entry },
    });
    await using actor = createReplyRecoveryActorFixture({
      ...target,
      getSessionId: () => target.sessionId,
    });
    const recovery = createReplyRestartRecoveryClaimController({
      ...target,
      acquireSessionActor: () => actor.acquireSessionActor(),
      admissionRunId: "inbound-run",
      sourceTurnId: "channel-user:v1:synthetic-dm",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      getEntry: () => entry,
      getSessionId: () => target.sessionId,
      setEntry: (next) => {
        entry = next;
      },
      isRestartAbort: () => false,
      resolveDeliveryContext: () => ({ channel: "telegram", to: "synthetic-chat" }),
    });
    const lane = `session:${target.sessionKey}`;
    const reading = createDeferred();
    const releaseRead = createDeferred();
    const queued = createDeferred();
    const cron = enqueueCommandInLane(lane, () =>
      SessionManager.readSessionContextAsync(target, async (messages) => {
        const snapshot = [...messages];
        reading.resolve();
        await releaseRead.promise;
        return snapshot;
      }),
    );
    await awaitGateBeforeSettlement(reading.promise, cron, "cron did not start reading context");
    const adopted = vi.fn();
    vi.mocked(executeAgentTurn).mockImplementation((params) =>
      enqueueCommandInLane(
        lane,
        async () => {
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
              didLogHeartbeatStrip: false,
            },
          };
        },
        { onQueued: () => queued.resolve(), abortSignal: params.replyOperation?.abortSignal },
      ),
    );
    const typing = createMockTypingController();
    const followupRun = createTestFollowupRun(target);
    followupRun.userTurnTranscriptRecorder = recorder;
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
      replyMediaContext: { normalizePayload: async (payload) => payload },
      replyRouteThreadId: undefined,
      replyToChannel: "telegram",
      replyToMode: "off",
      typingMode: "never",
      typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
      applyReplyToMode: (payload) => payload,
      getActiveSessionEntry: () => entry,
      setActiveSessionEntry: (next) => {
        if (next) {
          entry = next;
        }
      },
      isRestartRecoveryArmed: recovery.isArmed,
      resolveVisibleReplyDelivery: async () => false,
      returnWithQueuedFollowupDrain: (value) => value,
      sendDirectCompactionNotice: undefined,
      setRunFollowupTurn: () => {},
      runFollowupTurn: async () => {},
      shouldEmitToolOutput: () => false,
      shouldEmitToolResult: () => false,
      traceAgentPhase: async (_name, run) => await run(),
      turnAdoptionLifecycle: { onAdopted: adopted },
    });
    try {
      await awaitGateBeforeSettlement(queued.promise, inbound, "inbound did not queue");
      expect(recorder.hasPersisted()).toBe(true);
      releaseRead.resolve();
      await expect(cron).resolves.toMatchObject([{ role: "user", content: "prior turn" }]);
      await inbound;
      const messages = await SessionManager.readSessionContextAsync(target, (rows) => [...rows]);
      expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
      expect(loadSessionEntry(target)?.restartRecoveryDeliverySourceRunId).toBe(
        "channel-user:v1:synthetic-dm",
      );
    } finally {
      releaseRead.resolve();
      await Promise.allSettled([cron, inbound]);
    }
  });
});
