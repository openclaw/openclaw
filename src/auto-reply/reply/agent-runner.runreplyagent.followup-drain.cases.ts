import { expect, it, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentInternalParams as AgentRunParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import * as pendingToolTaskDrain from "./pending-tool-task-drain.js";
import type { FollowupRun } from "./queue.js";
import { replyRunRegistry } from "./reply-run-registry.js";

type FollowupDrainFixture = {
  createMinimalRun: (params: {
    isActive: boolean;
    isRunActive: () => boolean;
    shouldFollowup: boolean;
    resolvedQueueMode: string;
    opts: InternalGetReplyOptions;
  }) => {
    followupRun: FollowupRun;
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce">;
  requireScheduledFollowupRunner: () => (run: FollowupRun) => Promise<void>;
};

export function registerFollowupDrainCases({
  createMinimalRun,
  runEmbeddedAgentMock,
  requireScheduledFollowupRunner,
}: FollowupDrainFixture): void {
  it.for([
    {
      name: "releases a queued followup after the pending tool delivery idle bound",
      elapsedMs: 30_000,
      owned: false,
    },
    {
      name: "keeps a queued followup owned until pending tool delivery settles",
      elapsedMs: 29_999,
      owned: true,
    },
  ])("$name", async ({ elapsedMs, owned }, { signal }) => {
    vi.useFakeTimers();
    const toolResultStarted = createDeferred();
    const toolResultReleased = createDeferred();
    const drainStarted = createDeferred();
    const originalDrain = pendingToolTaskDrain.drainPendingToolTasks;
    const drainSpy = vi
      .spyOn(pendingToolTaskDrain, "drainPendingToolTasks")
      .mockImplementation((options) => {
        const draining = originalDrain(options);
        if (options.tasks.size > 0) {
          drainStarted.resolve();
        }
        return draining;
      });
    runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      void params.onToolResult?.({ text: "pending tool result" });
      return { payloads: [{ text: "followup complete" }], meta: {} };
    });
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      isRunActive: () => false,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
      opts: {
        forceToolResultProgress: true,
        onToolResult: async () => {
          toolResultStarted.resolve();
          await toolResultReleased.promise;
        },
      },
    });
    let followup: Promise<void> | undefined;
    try {
      await run();
      followup = requireScheduledFollowupRunner()(followupRun);
      // Callback entry precedes execution settlement and the drain's idle timer.
      await withinTest(Promise.all([toolResultStarted.promise, drainStarted.promise]), signal);

      await vi.advanceTimersByTimeAsync(elapsedMs);
      if (!owned) {
        await withinTest(followup, signal);
      }
      expect(replyRunRegistry.get("main") !== undefined).toBe(owned);

      toolResultReleased.resolve();
      await followup;
      expect(replyRunRegistry.get("main")).toBeUndefined();
    } finally {
      toolResultReleased.resolve();
      try {
        await followup;
      } finally {
        drainSpy.mockRestore();
        vi.useRealTimers();
      }
    }
  });
}
