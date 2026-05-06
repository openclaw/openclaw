/**
 * Tests for post-compaction delegate dispatch error handling.
 *
 * Silent catch was swallowing post-compaction delegate spawn failures.
 * This test verifies that spawn failures are now properly logged and surfaced
 * as system events, matching the pattern in the regular delegate dispatch path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture mock state for assertions
const mockState = vi.hoisted(() => ({
  spawnSubagentDirect: vi.fn(),
  warnLog: vi.fn(),
  infoLog: vi.fn(),
  enqueueSystemEvent: vi.fn(),
}));

// Mock spawnSubagentDirect — this is what we'll make throw
vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: mockState.spawnSubagentDirect,
}));

// Mock the subsystem logger to capture log.warn calls
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: mockState.infoLog,
    warn: mockState.warnLog,
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock enqueueSystemEvent to capture system events
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: mockState.enqueueSystemEvent,
}));

import { dispatchStagedPostCompactionDelegates } from "./delegate-dispatch.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatchStagedPostCompactionDelegates error handling", () => {
  it("directly dispatches accepted delegates with post-compaction wake flags", async () => {
    const sessionKey = "session-post-compact-accepted";
    const spawnCtx = { agentSessionKey: sessionKey, agentChannel: "discord" };
    mockState.spawnSubagentDirect.mockResolvedValueOnce({ status: "accepted" });

    const result = await dispatchStagedPostCompactionDelegates(
      [{ task: "rehydrate workspace state after compaction" }],
      sessionKey,
      spawnCtx,
    );

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(mockState.spawnSubagentDirect).toHaveBeenCalledWith(
      {
        task: "rehydrate workspace state after compaction",
        silentAnnounce: true,
        wakeOnReturn: true,
        drainsContinuationDelegateQueue: true,
      },
      spawnCtx,
    );
    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("logs warn + enqueues system event when spawnSubagentDirect throws", async () => {
    const sessionKey = "session-post-compact-fail";
    const testError = new Error("registry rejection: chain depth exceeded");

    mockState.spawnSubagentDirect.mockRejectedValueOnce(testError);

    const delegates = [{ task: "rehydrate workspace state after compaction" }];
    const spawnCtx = { agentSessionKey: sessionKey };

    const result = await dispatchStagedPostCompactionDelegates(delegates, sessionKey, spawnCtx);

    // Verify the failure was tracked
    expect(result.failed).toBe(1);
    expect(result.dispatched).toBe(0);

    // Verify warn log was called with the correct anchor
    expect(mockState.warnLog).toHaveBeenCalledOnce();
    const warnCall = mockState.warnLog.mock.calls[0][0];
    expect(warnCall).toContain("[continuation:post-compaction-spawn-failed]");
    expect(warnCall).toContain("registry rejection: chain depth exceeded");
    expect(warnCall).toContain(sessionKey);
    expect(warnCall).toContain("rehydrate workspace state");

    // Verify system event was enqueued
    expect(mockState.enqueueSystemEvent).toHaveBeenCalledOnce();
    const [eventMessage, eventOpts] = mockState.enqueueSystemEvent.mock.calls[0];
    expect(eventMessage).toContain("[continuation] Post-compaction delegate spawn failed");
    expect(eventMessage).toContain("registry rejection: chain depth exceeded");
    expect(eventMessage).toContain("rehydrate workspace state after compaction");
    expect(eventOpts).toEqual({ sessionKey });
  });

  it("logs info on dispatch start regardless of outcome", async () => {
    const sessionKey = "session-post-compact-info";

    mockState.spawnSubagentDirect.mockRejectedValueOnce(new Error("test error"));

    const delegates = [{ task: "test delegate" }];
    await dispatchStagedPostCompactionDelegates(delegates, sessionKey, {
      agentSessionKey: sessionKey,
    });

    // Verify info log was called with delegate count
    expect(mockState.infoLog).toHaveBeenCalledOnce();
    const infoCall = mockState.infoLog.mock.calls[0][0];
    expect(infoCall).toContain("[continuation:compaction-delegate]");
    expect(infoCall).toContain("Consuming 1 compaction delegate(s)");
    expect(infoCall).toContain(sessionKey);
  });

  it("handles non-Error thrown values gracefully", async () => {
    const sessionKey = "session-non-error";

    // Throw a string instead of an Error object
    mockState.spawnSubagentDirect.mockRejectedValueOnce("lane queue full");

    const delegates = [{ task: "test task" }];
    const result = await dispatchStagedPostCompactionDelegates(delegates, sessionKey, {
      agentSessionKey: sessionKey,
    });

    expect(result.failed).toBe(1);

    // Should still log and enqueue event with the string value
    expect(mockState.warnLog).toHaveBeenCalledOnce();
    expect(mockState.warnLog.mock.calls[0][0]).toContain("lane queue full");

    expect(mockState.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(mockState.enqueueSystemEvent.mock.calls[0][0]).toContain("lane queue full");
  });

  it("continues dispatching remaining delegates after a failure", async () => {
    const sessionKey = "session-continue-after-fail";

    // First delegate fails, second succeeds
    mockState.spawnSubagentDirect
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce({ status: "accepted" });

    const delegates = [{ task: "delegate-1" }, { task: "delegate-2" }];
    const result = await dispatchStagedPostCompactionDelegates(delegates, sessionKey, {
      agentSessionKey: sessionKey,
    });

    expect(result.failed).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(mockState.spawnSubagentDirect).toHaveBeenCalledTimes(2);
  });

  it("counts non-accepted spawn statuses as failed, not dispatched", async () => {
    const sessionKey = "session-post-compact-rejected";

    mockState.spawnSubagentDirect.mockResolvedValueOnce({ status: "forbidden" });

    const delegates = [{ task: "delegate rejected by policy" }];
    const result = await dispatchStagedPostCompactionDelegates(delegates, sessionKey, {
      agentSessionKey: sessionKey,
    });

    expect(result.failed).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(mockState.warnLog).toHaveBeenCalledOnce();
    expect(mockState.warnLog.mock.calls[0][0]).toContain(
      "[continuation:post-compaction-spawn-rejected]",
    );
    expect(mockState.warnLog.mock.calls[0][0]).toContain("status=forbidden");
    expect(mockState.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(mockState.enqueueSystemEvent.mock.calls[0][0]).toContain(
      "Post-compaction delegate spawn forbidden",
    );
  });

  it("truncates long task strings in warn log to 80 chars", async () => {
    const sessionKey = "session-truncate";
    const longTask =
      "This is a very long task description that exceeds eighty characters and should be truncated in the log message for readability";

    mockState.spawnSubagentDirect.mockRejectedValueOnce(new Error("spawn failed"));

    await dispatchStagedPostCompactionDelegates([{ task: longTask }], sessionKey, {
      agentSessionKey: sessionKey,
    });

    const warnCall = mockState.warnLog.mock.calls[0][0];
    // The task in the log should be truncated
    expect(warnCall).toContain(longTask.slice(0, 80));
    expect(warnCall).not.toContain(longTask.slice(80));

    // But the system event should contain the full task
    const eventMessage = mockState.enqueueSystemEvent.mock.calls[0][0];
    expect(eventMessage).toContain(longTask);
  });
});
