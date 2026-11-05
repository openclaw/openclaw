import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { useAccountingFixture } from "./agent-runner-accounting.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

const { createFixture } = useAccountingFixture("openclaw-goal-compaction-");
afterEach(clearRuntimeConfigSnapshot);

// Keep real terminal accounting, completion commit, Goal admission, and mailbox.
// The existing persistence fixture supplies the durable same-session compaction
// fact emitted by overflow recovery; this does not simulate provider transport.
it.each([false, true])(
  "admits one Goal successor after same-session compaction (late activation: %s)",
  async (lateActivation) => {
    const fixture = await createFixture();
    const { context } = fixture;
    setRuntimeConfigSnapshot(context.cfg);
    const goal = {
      schemaVersion: 1 as const,
      id: "compaction-goal",
      status: lateActivation ? ("paused" as const) : ("active" as const),
      objective: "Finish the remaining work",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 370222,
      tokensUsed: 0,
      continuationTurns: 0,
    };
    context.activeSessionEntry = await fixture.patch({ goal, agentHarnessId: "openclaw" });
    context.activeSessionStore![context.sessionKey!] = context.activeSessionEntry;
    fixture.recordCompaction({ currentContextTokens: 87928 });
    fixture.setMeta({ agentHarnessId: "openclaw", usage: { input: 87928, output: 483 } });
    context.execution.result.meta.stopReason = "stop";
    context.execution.result.meta.completion = { finishReason: "stop" };
    context.execution.result.payloads = [
      { text: "More work remains.", mediaUrl: "https://example.invalid/evidence.png" },
    ];
    // Payload normalization occurs after accountAgentTurn captures its projection,
    // but before completion refreshes and commits the authoritative postimage.
    let activated = false;
    const normalize = vi.fn<typeof context.replyMediaContext.normalizePayload>(async (payload) => {
      if (lateActivation && !activated) {
        activated = true;
        await fixture.patch({ goal: { ...goal, status: "active", updatedAt: 2 } });
      }
      return payload;
    });
    context.replyMediaContext.normalizePayload = normalize;
    const runFollowup = vi.fn(async () => {});
    context.runFollowupTurn = runFollowup;
    try {
      await finalizeReplyAgentRun(context);
      expect(normalize).toHaveBeenCalledOnce();
      expect(activated).toBe(lateActivation);
      expect(fixture.read()).toMatchObject({
        sessionId: fixture.sessionId,
        compactionCount: 1,
        goal: { id: goal.id, status: "active" },
      });
      // Inspect the actual controller mailbox, not a mocked enqueue function.
      const queued = getExistingFollowupQueue(context.queueKey)?.items ?? [];
      expect(queued).toHaveLength(1);
      expect(queued[0]?.goalContinuation).toMatchObject({
        sessionId: fixture.sessionId,
        lifecycleRevision: context.activeSessionEntry!.lifecycleRevision,
        goalId: goal.id,
      });
      expect(queued[0]?.messageId).toBe(
        ["goal", fixture.sessionId, goal.id, context.runId].join(":"),
      );
      expect(fixture.read()?.goalSuccessor).toMatchObject({
        sessionId: fixture.sessionId,
        goalId: goal.id,
        sourceRunId: context.runId,
        phase: "pending",
      });
      // Admission transfers custody; it must not execute under the old owner.
      expect(runFollowup).not.toHaveBeenCalled();
    } finally {
      clearFollowupQueue(context.queueKey);
    }
  },
);
