import { expect } from "vitest";
import {
  resetGeneratedMediaTaskActivityForTests,
  admitMediaHandle,
} from "../media-generation-activity.test-support.js";

type MockWithReset = { mockReset(): void };

type TaskExecutorBackgroundMocks = {
  createOperation: MockWithReset;
  recordProgress: MockWithReset;
  completeOperation: MockWithReset;
  failOperation: MockWithReset;
};

type MediaBackgroundResetMocks = {
  taskExecutorMocks: TaskExecutorBackgroundMocks;
  announceDeliveryMocks: { deliverSubagentAnnouncement: MockWithReset };
};

type FallbackAnnouncementExpectation = {
  deliverAnnouncementMock: unknown;
  requesterSessionKey: string;
  channel: string;
  to: string;
  source: string;
  announceType: string;
  resultMediaPath: string;
  mediaUrls: string[];
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
  return requireRecord((mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[0]?.[0], label);
}

function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value.map((entry, index) => requireRecord(entry, `${label}[${index}]`));
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
  taskExecutorMocks,
  announceDeliveryMocks,
}: MediaBackgroundResetMocks): void {
  resetGeneratedMediaTaskActivityForTests();
  taskExecutorMocks.createOperation.mockReset();
  taskExecutorMocks.recordProgress.mockReset();
  taskExecutorMocks.completeOperation.mockReset();
  taskExecutorMocks.failOperation.mockReset();
  announceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
}

export function expectFallbackMediaAnnouncement({
  deliverAnnouncementMock,
  requesterSessionKey,
  channel,
  to,
  source,
  announceType,
  resultMediaPath,
  mediaUrls,
}: FallbackAnnouncementExpectation): void {
  // Fallback announcements are agent-mediated completions: internal events must
  // carry media URLs and a visible-reply instruction for the completion agent.
  expect(deliverAnnouncementMock).toHaveBeenCalledTimes(1);
  const params = requireMockFirstParam(
    deliverAnnouncementMock,
    "deliverSubagentAnnouncement params",
  );
  expect(params).toMatchObject({
    requesterSessionKey,
    requesterSessionOrigin: { channel, to },
    expectsCompletionMessage: true,
  });
  const event = requireRecordArray(params.internalEvents, "internalEvents").find(
    (candidate) => candidate.source === source && candidate.announceType === announceType,
  );
  expect(event).toMatchObject({ status: "ok", mediaUrls });
  expect(String(event?.result)).toContain(resultMediaPath);
  expect(String(event?.replyInstruction)).toContain("visible-reply contract");
}
