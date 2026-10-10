// Media generation background test support centralizes task/announcement mocks
// and assertions shared by image, video, and music generation tests.
import { expect, vi } from "vitest";
import {
  resetGeneratedMediaTaskActivityForTests,
  admitMediaHandle,
} from "../media-generation-activity.test-support.js";

type MockWithReset = {
  mockReset(): void;
  mockResolvedValue?(value: unknown): void;
  mockReturnValue?(value: unknown): void;
};

export const taskDeliveryRuntimeMocks = {
  sendMessage: vi.fn(),
};

type TaskExecutorBackgroundMocks = {
  createOperation: MockWithReset;
  recordProgress: MockWithReset;
  completeOperation: MockWithReset;
  failOperation: MockWithReset;
};

type TaskDeliveryBackgroundMocks = {
  sendMessage: MockWithReset;
};

type AnnouncementBackgroundMocks = {
  deliverSubagentAnnouncement: MockWithReset;
};

type MediaBackgroundResetMocks = {
  taskExecutorMocks: TaskExecutorBackgroundMocks;
  taskDeliveryRuntimeMocks: TaskDeliveryBackgroundMocks;
  announceDeliveryMocks: AnnouncementBackgroundMocks;
};

type QueuedTaskExpectation = {
  taskExecutorMocks: TaskExecutorBackgroundMocks;
  taskKind: string;
  sourceId: string;
  progressSummary: string;
};

type CompletionFixtureParams = {
  mediaUrls?: string[];
  result: string;
  runId: string;
  taskLabel: string;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireMockFirstParam(mock: unknown, label: string): Record<string, unknown> {
  const first = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[0]?.[0];
  return requireRecord(first, label);
}

export function createMediaCompletionFixture({
  mediaUrls,
  result,
  runId,
  taskLabel,
}: CompletionFixtureParams) {
  return {
    handle: admitMediaHandle({
      taskId: "task-123",
      runId,
      requesterSessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
        threadId: "thread-1",
      },
      taskLabel,
    }),
    status: "ok" as const,
    statusLabel: "completed successfully",
    result,
    ...(mediaUrls ? { mediaUrls } : {}),
  };
}

export function resetMediaBackgroundMocks({
  taskExecutorMocks: taskExecutorMocksResult,
  taskDeliveryRuntimeMocks: taskDeliveryRuntimeMocksLocal,
  announceDeliveryMocks: announceDeliveryMocksLocal,
}: MediaBackgroundResetMocks): void {
  resetGeneratedMediaTaskActivityForTests();
  taskExecutorMocksResult.createOperation.mockReset();
  taskExecutorMocksResult.recordProgress.mockReset();
  taskExecutorMocksResult.completeOperation.mockReset();
  taskExecutorMocksResult.failOperation.mockReset();
  taskDeliveryRuntimeMocksLocal.sendMessage.mockReset();
  taskDeliveryRuntimeMocksLocal.sendMessage.mockResolvedValue?.({
    channel: "discord",
    to: "channel:1",
    via: "direct",
    mediaUrl: null,
    result: { messageId: "msg-1" },
  });
  announceDeliveryMocksLocal.deliverSubagentAnnouncement.mockReset();
}

export function expectQueuedTaskRun({
  taskExecutorMocks: taskExecutorMocksValue,
  taskKind,
  sourceId,
  progressSummary,
}: QueuedTaskExpectation): void {
  const params = requireMockFirstParam(
    taskExecutorMocksValue.createOperation,
    "createOperation params",
  );
  expect(params.taskKind).toBe(taskKind);
  expect(params.sourceId).toBe(sourceId);
  expect(params.progressSummary).toBe(progressSummary);
}
