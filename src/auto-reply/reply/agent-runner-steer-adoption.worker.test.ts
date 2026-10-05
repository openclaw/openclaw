import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupDrainCallback } from "./queue/drain.js";
import { clearFollowupQueue } from "./queue/state.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

it("adopts active steering through prepared policy without caller-thread SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:active-worker-steering";
    const policyKey = "agent:main:active-worker-policy";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: policyKey },
      { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
    );
    const run = createQueueTestRun({
      prompt: "use the new requirements",
      messageId: "incoming-steer",
      originatingChannel: "webchat",
    });
    Object.assign(run.run, {
      agentId: "main",
      sessionKey: key,
      runtimePolicySessionKey: policyKey,
      senderIsOwner: true,
      config: {
        agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
        tools: { sandbox: { tools: { deny: ["exec"] } } },
      },
    });
    const operation = createTestReplyOperation({ sessionKey: key, sessionId: run.run.sessionId });
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
    const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
    const delivered: string[] = [];
    operation.attachBackend({
      kind: "embedded",
      cancel() {},
      toolAuthorityFingerprint: fingerprint,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        async queueMessage() {
          throw new Error("Expected awaited steering preparation");
        },
        async queueMessageAsync(text, options, preparation) {
          await preparation.prepareCurrent();
          preparation.assertCurrent();
          delivered.push(text);
          options?.onQueueAccepted?.(true);
        },
      },
    });
    operation.setPhase("running");
    const typing = createMockTypingController();
    const resultState: ReplyOperationRunState = {};
    const followup = vi.fn(async () => {});
    const releaseAdmissionTicket = vi.fn();
    const calls = observeMainThreadSql();
    try {
      await expect(
        runActiveReplySteer({
          followupRun: run,
          opts: { runId: "incoming-steer" },
          providedReplyOperation: operation,
          queueKey: key,
          releaseAdmissionTicket,
          replyOperationRunState: resultState,
          resolvedQueue: { mode: "steer", debounceMs: 0 },
          restartRecoverySourceTurnId: undefined,
          runFollowup: followup,
          sessionCtx: {},
          sessionKey: key,
          // The optional restart-recovery store read is separate from moved tool-policy work.
          touchActiveSessionEntry: async () => {},
          typing,
          typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
          toolAuthorityFingerprint: fingerprint,
        }),
      ).resolves.toBe("handled");
      expect(delivered).toEqual([run.prompt]);
      expect(resultState.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(followup).not.toHaveBeenCalled();
      expect(releaseAdmissionTicket).toHaveBeenCalledOnce();
      calls.expectIdle();
    } finally {
      calls.restore();
      clearFollowupQueue(key);
      clearFollowupDrainCallback(key);
      operation.complete();
    }
  });
});
