import { beforeEach, describe, expect, it, vi } from "vitest";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  createVideoGenerationTaskRun,
  recordVideoGenerationTaskProgress,
  wakeVideoGenerationTaskCompletion,
} from "./video-generate-background.js";

const taskExecutorMocks = vi.hoisted(() => ({
  createRunningTaskRun: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
}));

const announceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
}));
const taskDeliveryRuntimeMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("../../tasks/task-executor.js", () => taskExecutorMocks);
vi.mock("../../tasks/task-registry-delivery-runtime.js", () => taskDeliveryRuntimeMocks);
vi.mock("../subagent-announce-delivery.js", () => announceDeliveryMocks);

describe("video generate background helpers", () => {
  beforeEach(() => {
    taskExecutorMocks.createRunningTaskRun.mockReset();
    taskExecutorMocks.recordTaskRunProgressByRunId.mockReset();
    taskDeliveryRuntimeMocks.sendMessage.mockReset();
    announceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
  });

  it("creates a running task with queued progress text", () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
    });

    const handle = createVideoGenerationTaskRun({
      sessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      prompt: "friendly lobster surfing",
      providerId: "openai",
    });

    expect(handle).toMatchObject({
      taskId: "task-123",
      requesterSessionKey: "agent:main:discord:direct:123",
      taskLabel: "friendly lobster surfing",
    });
    expect(taskExecutorMocks.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        progressSummary: "Queued video generation",
      }),
    );
  });

  it("records task progress updates", () => {
    recordVideoGenerationTaskProgress({
      handle: {
        taskId: "task-123",
        runId: "tool:video_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "friendly lobster surfing",
      },
      progressSummary: "Saving generated video",
    });

    expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "tool:video_generate:abc",
        progressSummary: "Saving generated video",
      }),
    );
  });

  it("delivers completed video directly to the requester channel", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockResolvedValue({
      channel: "discord",
      messageId: "msg-1",
    });

    await wakeVideoGenerationTaskCompletion({
      handle: {
        taskId: "task-123",
        runId: "tool:video_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:1",
          threadId: "thread-1",
        },
        taskLabel: "friendly lobster surfing",
      },
      status: "ok",
      statusLabel: "completed successfully",
      result: "Generated 1 video.\nMEDIA:/tmp/generated-lobster.mp4",
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:1",
        threadId: "thread-1",
        content: "Generated 1 video.",
        mediaUrls: ["/tmp/generated-lobster.mp4"],
      }),
    );
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).not.toHaveBeenCalled();
  });

  it("falls back to a video-generation completion event when direct delivery fails", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockRejectedValue(new Error("discord upload failed"));
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeVideoGenerationTaskCompletion({
      handle: {
        taskId: "task-123",
        runId: "tool:video_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:1",
          threadId: "thread-1",
        },
        taskLabel: "friendly lobster surfing",
      },
      status: "ok",
      statusLabel: "completed successfully",
      result: "Generated 1 video.\nMEDIA:/tmp/generated-lobster.mp4",
      mediaUrls: ["/tmp/generated-lobster.mp4"],
    });

    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: expect.objectContaining({
          channel: "discord",
          to: "channel:1",
        }),
        expectsCompletionMessage: true,
        internalEvents: expect.arrayContaining([
          expect.objectContaining({
            source: "video_generation",
            announceType: "video generation task",
            status: "ok",
            result: expect.stringContaining("MEDIA:/tmp/generated-lobster.mp4"),
            mediaUrls: ["/tmp/generated-lobster.mp4"],
            replyInstruction: expect.stringContaining("Prefer the message tool for delivery"),
          }),
        ]),
      }),
    );
  });
});
