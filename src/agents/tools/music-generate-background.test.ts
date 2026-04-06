import { beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  createMusicGenerationTaskRun,
  recordMusicGenerationTaskProgress,
  wakeMusicGenerationTaskCompletion,
} from "./music-generate-background.js";

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

describe("music generate background helpers", () => {
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

    const handle = createMusicGenerationTaskRun({
      sessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      prompt: "night-drive synthwave",
      providerId: "google",
    });

    expect(handle).toMatchObject({
      taskId: "task-123",
      requesterSessionKey: "agent:main:discord:direct:123",
      taskLabel: "night-drive synthwave",
    });
    expect(taskExecutorMocks.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        taskKind: MUSIC_GENERATION_TASK_KIND,
        sourceId: "music_generate:google",
        progressSummary: "Queued music generation",
      }),
    );
  });

  it("records task progress updates", () => {
    recordMusicGenerationTaskProgress({
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "night-drive synthwave",
      },
      progressSummary: "Saving generated music",
    });

    expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "tool:music_generate:abc",
        progressSummary: "Saving generated music",
      }),
    );
  });

  it("delivers completed music directly to the requester channel", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockResolvedValue({
      channel: "discord",
      messageId: "msg-1",
    });

    await wakeMusicGenerationTaskCompletion({
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:1",
          threadId: "thread-1",
        },
        taskLabel: "night-drive synthwave",
      },
      status: "ok",
      statusLabel: "completed successfully",
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:1",
        threadId: "thread-1",
        content: "Generated 1 track.",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
      }),
    );
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).not.toHaveBeenCalled();
  });

  it("falls back to a music-generation completion event when direct delivery fails", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockRejectedValue(new Error("discord upload failed"));
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeMusicGenerationTaskCompletion({
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:1",
          threadId: "thread-1",
        },
        taskLabel: "night-drive synthwave",
      },
      status: "ok",
      statusLabel: "completed successfully",
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
    });

    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: expect.objectContaining({
          channel: "discord",
          to: "channel:1",
        }),
        expectsCompletionMessage: true,
        internalEvents: [
          expect.objectContaining({
            source: "music_generation",
            announceType: "music generation task",
            status: "ok",
            result: expect.stringContaining("MEDIA:/tmp/generated-night-drive.mp3"),
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
            replyInstruction: expect.stringContaining("include those exact MEDIA: lines"),
          }),
        ],
      }),
    );
  });
});
