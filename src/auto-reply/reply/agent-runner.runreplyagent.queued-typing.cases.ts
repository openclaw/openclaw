import { expect, it, vi, type Mock } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
} from "./queue.js";
import { createReplyOperation } from "./reply-run-registry.js";
import type { TypingController } from "./typing.js";

type QueuedTypingFixture = {
  createMinimalRun: (params: {
    opts?: InternalGetReplyOptions;
    isActive?: boolean;
    isRunActive?: () => boolean;
    shouldFollowup?: boolean;
    resolvedQueueMode?: "collect";
    typingMode?: "message";
  }) => {
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
    typing: TypingController;
  };
  runEmbeddedAgentMock: Mock;
};

export function registerQueuedTypingCases({
  createMinimalRun,
  runEmbeddedAgentMock,
}: QueuedTypingFixture): void {
  it("keeps typing alive when a followup is queued behind a live active run", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.cleanup).not.toHaveBeenCalled();
    active.complete();
  });

  it("hands queued typing to the follow-up lifecycle and closes it when the item settles", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    const onTypingHandoff = vi.fn();
    const { run, typing } = createMinimalRun({
      opts: {
        isHeartbeat: false,
        onTypingHandoff,
        turnAdoptionLifecycle: { admission: "exclusive", onAdopted: () => undefined },
      },
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });
    vi.mocked(typing.startTypingLoop).mockImplementation(async () => {
      vi.mocked(typing.isActive).mockReturnValue(true);
    });

    expect(await run()).toBeUndefined();
    expect(onTypingHandoff).toHaveBeenCalledTimes(1);
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.cleanup).not.toHaveBeenCalled();

    const queued = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    if (!queued) {
      throw new Error("expected an enqueued follow-up");
    }
    completeFollowupRunLifecycle(queued);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
    active.complete();
  });

  it("keeps idle ownership with the dispatch when queued typing never starts", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    const onTypingHandoff = vi.fn();
    const { run, typing } = createMinimalRun({
      opts: {
        isHeartbeat: false,
        onTypingHandoff,
        turnAdoptionLifecycle: { admission: "exclusive", onAdopted: () => undefined },
      },
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
      typingMode: "message",
    });

    expect(await run()).toBeUndefined();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(onTypingHandoff).not.toHaveBeenCalled();
    active.complete();
  });
}
