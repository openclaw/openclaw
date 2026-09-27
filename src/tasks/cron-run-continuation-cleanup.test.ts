import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { DeleteSessionEntryLifecycleParams } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";

type Continuation = NonNullable<SessionEntry["cronRunContinuation"]>;
const mocks = vi.hoisted(() => ({
  deleteEntry: vi.fn(async (_params: DeleteSessionEntryLifecycleParams) => ({
    deleted: true,
    archivedTranscripts: [],
  })),
  descendants: new Map<string, SubagentRunRecord>(),
  hasPendingMedia: vi.fn(() => false),
  loadPendingSessionDeliveries: vi.fn(async () => []),
  loadEntry: vi.fn<() => SessionEntry | undefined>(),
}));

vi.mock("../agents/subagents/registry/subagent-registry-state.js", () => ({
  getSubagentRunsSnapshotForSessions: () => mocks.descendants,
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/tmp/sessions.json",
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  deleteSessionEntryLifecycle: mocks.deleteEntry,
  loadSessionEntry: mocks.loadEntry,
}));
vi.mock("../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "current-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) =>
    generation === "current-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));
vi.mock("../infra/session-delivery-queue-storage.js", () => ({
  loadPendingSessionDeliveries: mocks.loadPendingSessionDeliveries,
}));
vi.mock("./task-status-access.js", () => ({
  hasPendingGeneratedMediaTaskForSessionKey: mocks.hasPendingMedia,
}));

import { removeCronRunContinuationSessionIfIdle } from "./cron-run-continuation-cleanup.js";

const marker = (overrides: Partial<Continuation> = {}): Continuation => ({
  lifecycleRevision: "revision-1",
  phase: "ready",
  basePersisted: true,
  ...overrides,
});
const ownedMarker = (ownerLifecycleGeneration: string, basePersisted = true) =>
  marker({
    phase: "continuing",
    basePersisted,
    ownerRunId: "owner-run",
    ownerLifecycleGeneration,
  });
const cases: Array<[string, Continuation, boolean, boolean]> = [
  ["idle ready", marker(), false, true],
  ["idle retired owner", ownedMarker("retired-generation"), false, true],
  ["current owner", ownedMarker("current-generation"), false, false],
  ["unpersisted base", ownedMarker("retired-generation", false), false, false],
  ["pending media", marker(), true, false],
];

describe("removeCronRunContinuationSessionIfIdle", () => {
  const sessionKey = "agent:main:cron:one-shot:run:run-123";

  beforeEach(() => {
    mocks.deleteEntry.mockClear();
    mocks.descendants.clear();
    mocks.hasPendingMedia.mockReset();
    mocks.loadPendingSessionDeliveries.mockReset().mockResolvedValue([]);
    mocks.loadEntry.mockReset();
  });

  it.each(cases)("handles %s", async (_name, continuation, pending, deleted) => {
    mocks.hasPendingMedia.mockReturnValue(pending);
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: continuation,
    });

    await removeCronRunContinuationSessionIfIdle(sessionKey);

    expect(mocks.deleteEntry).toHaveBeenCalledTimes(deleted ? 1 : 0);
  });

  it("keeps a continuation while its durable session delivery is pending", async () => {
    mocks.loadPendingSessionDeliveries.mockResolvedValueOnce([
      {
        id: "pending-media",
        kind: "agentTurn",
        sessionKey,
        message: "generated image ready",
        messageId: "image:task-1:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
      },
    ] as never);

    await removeCronRunContinuationSessionIfIdle(sessionKey);

    expect(mocks.loadEntry).not.toHaveBeenCalled();
    expect(mocks.deleteEntry).not.toHaveBeenCalled();
  });

  it("retains the parent until its native child finishes and its completion settles", async () => {
    const child = createSubagentRunRecord({
      runId: "child-run",
      requesterSessionKey: sessionKey,
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
    });
    mocks.descendants.set(child.runId, child);
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: marker(),
    });

    await removeCronRunContinuationSessionIfIdle(sessionKey);
    expect(mocks.deleteEntry).not.toHaveBeenCalled();

    child.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
    await removeCronRunContinuationSessionIfIdle(sessionKey);
    expect(mocks.deleteEntry).not.toHaveBeenCalled();

    child.delivery = { status: "delivered", disposition: "delivered" };
    const otherRunChild = createSubagentRunRecord({
      runId: "other-cron-child",
      childSessionKey: "agent:main:subagent:other-child",
      requesterSessionKey: "agent:main:cron:one-shot:run:another-run",
    });
    mocks.descendants.set(otherRunChild.runId, otherRunChild);
    await removeCronRunContinuationSessionIfIdle(sessionKey);
    expect(mocks.deleteEntry).toHaveBeenCalledTimes(1);
  });

  it("rechecks native children after reading queued deliveries", async () => {
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: marker(),
    });
    mocks.loadPendingSessionDeliveries.mockImplementationOnce(async () => {
      const child = createSubagentRunRecord({
        runId: "child-admitted-during-queue-read",
        requesterSessionKey: sessionKey,
      });
      mocks.descendants.set(child.runId, child);
      return [];
    });

    await removeCronRunContinuationSessionIfIdle(sessionKey);

    expect(mocks.deleteEntry).not.toHaveBeenCalled();
  });

  it("fences a child admitted while session deletion is preparing", async () => {
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: marker(),
    });
    mocks.deleteEntry.mockImplementationOnce(async (params) => {
      const child = createSubagentRunRecord({
        runId: "child-admitted-during-deletion",
        requesterSessionKey: sessionKey,
      });
      mocks.descendants.set(child.runId, child);
      params.commitGuard?.();
      return { deleted: true, archivedTranscripts: [] };
    });

    await expect(removeCronRunContinuationSessionIfIdle(sessionKey)).rejects.toThrow(
      "cron run continuation still has unsettled subagents",
    );
  });

  it("removes a continuation while finalizing its settled delivery row", async () => {
    mocks.loadPendingSessionDeliveries.mockResolvedValueOnce([
      {
        id: "settled-media",
        kind: "agentTurn",
        sessionKey,
        message: "generated image ready",
        messageId: "image:task-1:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        settlementOutcome: "recovered",
      },
    ] as never);
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: marker(),
    });

    await removeCronRunContinuationSessionIfIdle(sessionKey, "settled-media");

    expect(mocks.deleteEntry).toHaveBeenCalledTimes(1);
  });
});
