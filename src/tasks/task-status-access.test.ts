import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGeneratedMediaTaskActivity,
  registerGeneratedMediaTaskActivity,
} from "./generated-media-task-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "./task-runtime.test-helpers.js";
import {
  buildPendingGeneratedMediaSessionKeySet,
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
  hasPendingGeneratedMediaTaskForSessionKey,
} from "./task-status-access.js";

const mocks = vi.hoisted(() => ({ listTaskRecords: vi.fn() }));

vi.mock("./task-registry.js", () => ({
  findTaskByRunId: vi.fn(),
  getTaskById: vi.fn(),
  listTaskRecords: mocks.listTaskRecords,
  listTasksForAgentId: vi.fn(),
  listTasksForSessionKey: vi.fn(),
}));

describe("generated media task snapshots", () => {
  const sessionKey = "agent:main:cron:job:run:run-id";

  beforeEach(() => {
    resetGeneratedMediaTaskActivityForTests();
    mocks.listTaskRecords.mockReset();
  });

  it("detects only media admitted by the current exact-run attempt", () => {
    const tasks = [
      {
        taskId: "old-image",
        taskKind: "image_generation",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
      },
    ];
    mocks.listTaskRecords.mockImplementation(() => tasks);
    const before = getGeneratedMediaTaskIdsForSessionKey(sessionKey);

    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(false);
    tasks.push({
      taskId: "new-video",
      taskKind: "video_generation",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
    });
    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(true);
  });

  it("does not apply exact-run replay guards to descendant sessions", () => {
    mocks.listTaskRecords.mockReturnValue([]);
    expect(getGeneratedMediaTaskIdsForSessionKey(`${sessionKey}:subagent:worker`)).toEqual(
      new Set(),
    );
    expect(mocks.listTaskRecords).not.toHaveBeenCalled();
  });

  it("tracks active media when a detached runtime does not mirror core tasks", () => {
    mocks.listTaskRecords.mockReturnValue([]);
    const before = getGeneratedMediaTaskIdsForSessionKey(sessionKey);

    registerGeneratedMediaTaskActivity("tool:image_generate:run-1", sessionKey);
    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(true);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);

    clearGeneratedMediaTaskActivity("tool:image_generate:run-1");
    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(true);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
  });
});

describe("buildPendingGeneratedMediaSessionKeySet", () => {
  const sessionKey = "agent:main:cron:job:run:run-id";

  beforeEach(() => {
    resetGeneratedMediaTaskActivityForTests();
    mocks.listTaskRecords.mockReset();
  });

  it("returns an empty set when no active media and no persisted tasks", () => {
    mocks.listTaskRecords.mockReturnValue([]);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(new Set());
  });

  it("includes in-process active generated-media session keys", () => {
    mocks.listTaskRecords.mockReturnValue([]);
    registerGeneratedMediaTaskActivity("tool:image_generate:run-1", sessionKey);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(new Set([sessionKey]));
  });

  it("includes requester session keys from non-terminal generated-media tasks", () => {
    mocks.listTaskRecords.mockReturnValue([
      {
        taskId: "img-task",
        taskKind: "image_generation",
        status: "queued",
        requesterSessionKey: sessionKey,
        ownerKey: "other-owner",
      },
    ]);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(new Set([sessionKey, "other-owner"]));
  });

  it("includes owner keys from non-terminal generated-media tasks", () => {
    mocks.listTaskRecords.mockReturnValue([
      {
        taskId: "vid-task",
        taskKind: "video_generation",
        status: "running",
        requesterSessionKey: "other-requester",
        ownerKey: sessionKey,
      },
    ]);
    const result = buildPendingGeneratedMediaSessionKeySet();
    expect(result.has(sessionKey)).toBe(true);
    expect(result.has("other-requester")).toBe(true);
  });

  it("excludes terminal generated-media tasks", () => {
    mocks.listTaskRecords.mockReturnValue([
      {
        taskId: "done-task",
        taskKind: "image_generation",
        status: "succeeded",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
      },
    ]);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(new Set());
  });

  it("excludes non-generated-media tasks", () => {
    mocks.listTaskRecords.mockReturnValue([
      {
        taskId: "chat-task",
        taskKind: "chat",
        status: "running",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
      },
    ]);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(new Set());
  });

  it("combines active media and persisted tasks in one scan", () => {
    registerGeneratedMediaTaskActivity("tool:in-proc:run-1", "active-key");
    mocks.listTaskRecords.mockReturnValue([
      {
        taskId: "persisted-task",
        taskKind: "music_generation",
        status: "processing",
        requesterSessionKey: "persisted-key",
        ownerKey: "owner-key",
      },
    ]);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(
      new Set(["active-key", "persisted-key", "owner-key"]),
    );
  });
});
