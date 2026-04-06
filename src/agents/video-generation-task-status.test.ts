import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildActiveVideoGenerationTaskPromptContextForSession,
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  getVideoGenerationTaskProviderId,
  isActiveVideoGenerationTask,
} from "./video-generation-task-status.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

describe("video generation task status", () => {
  beforeEach(() => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
  });

  it("recognizes active session-backed video generation tasks", () => {
    expect(
      isActiveVideoGenerationTask({
        taskId: "task-1",
        runtime: "cli",
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make lobster video",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      }),
    ).toBe(true);
    expect(
      isActiveVideoGenerationTask({
        taskId: "task-2",
        runtime: "cron",
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make lobster video",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      }),
    ).toBe(false);
  });

  it("prefers a running task over queued session siblings", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-queued",
        runtime: "cli",
        sourceId: "video_generate:google",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "queued task",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
      {
        taskId: "task-running",
        runtime: "cli",
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating video",
      },
    ]);

    const task = findActiveVideoGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    expect(getVideoGenerationTaskProviderId(task!)).toBe("openai");
    expect(buildVideoGenerationTaskStatusText(task!, { duplicateGuard: true })).toContain(
      "Do not call video_generate again for this request.",
    );
    expect(buildVideoGenerationTaskStatusDetails(task!)).toMatchObject({
      active: true,
      existingTask: true,
      status: "running",
      provider: "openai",
      progressSummary: "Generating video",
    });
  });

  it("builds prompt context for active session work", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-running",
        runtime: "cli",
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating video",
      },
    ]);

    const context = buildActiveVideoGenerationTaskPromptContextForSession("agent:main");

    expect(context).toContain("An active video generation background task already exists");
    expect(context).toContain("Task task-running is currently running via openai.");
    expect(context).toContain('call `video_generate` with `action:"status"`');
  });
});
