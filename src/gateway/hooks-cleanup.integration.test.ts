import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./hook-run-registry.store.js", () => ({
  loadHookRunRegistryFromDisk: vi.fn(() => new Map()),
  saveHookRunRegistryToDisk: vi.fn(),
}));

vi.mock("./call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ ok: true }),
}));

describe("webhook hook cleanup integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("sweeper deletes session when cleanupAtMs is reached", async () => {
    const { callGateway } = await import("./call.js");
    const mockCallGateway = vi.mocked(callGateway);

    const { registerHookRun, markHookRunComplete, clearHookRuns } =
      await import("./hook-run-registry.js");
    clearHookRuns();

    // Register a hook run with immediate cleanup
    registerHookRun({
      runId: "test-run",
      sessionKey: "hook:test:123",
      jobName: "Test",
      cleanup: "delete",
      cleanupDelayMinutes: 0,
    });

    // Mark complete (sets cleanupAtMs to now and cleanupHandled to true)
    markHookRunComplete("test-run");

    // Advance time past the sweeper interval
    await vi.advanceTimersByTimeAsync(61_000);

    // Verify sessions.delete was called
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: { key: "hook:test:123", deleteTranscript: true },
      }),
    );

    clearHookRuns();
  });

  it("does not delete session when cleanup=keep", async () => {
    const { callGateway } = await import("./call.js");
    const mockCallGateway = vi.mocked(callGateway);

    const { registerHookRun, clearHookRuns } = await import("./hook-run-registry.js");
    clearHookRuns();

    // Register with cleanup=keep (should be no-op)
    registerHookRun({
      runId: "test-run",
      sessionKey: "hook:test:123",
      jobName: "Test",
      cleanup: "keep",
      cleanupDelayMinutes: 0,
    });

    // Advance time
    await vi.advanceTimersByTimeAsync(120_000);

    // Verify sessions.delete was NOT called
    expect(mockCallGateway).not.toHaveBeenCalled();

    clearHookRuns();
  });

  it("respects cleanupDelayMinutes", async () => {
    const { callGateway } = await import("./call.js");
    const mockCallGateway = vi.mocked(callGateway);

    const { registerHookRun, markHookRunComplete, clearHookRuns } =
      await import("./hook-run-registry.js");
    clearHookRuns();

    // Register with 5 minute delay
    registerHookRun({
      runId: "test-run",
      sessionKey: "hook:test:123",
      jobName: "Test",
      cleanup: "delete",
      cleanupDelayMinutes: 5,
    });

    markHookRunComplete("test-run");

    // Advance 2 minutes - should NOT delete yet
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockCallGateway).not.toHaveBeenCalled();

    // Advance past 5 minutes total (need to trigger sweeper at 6 min mark)
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
      }),
    );

    clearHookRuns();
  });

  it("retries on RPC failure", async () => {
    const { callGateway } = await import("./call.js");
    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockRejectedValueOnce(new Error("RPC failed"));
    mockCallGateway.mockResolvedValueOnce({ ok: true });

    const { registerHookRun, markHookRunComplete, getHookRun, clearHookRuns } =
      await import("./hook-run-registry.js");
    clearHookRuns();

    registerHookRun({
      runId: "test-run",
      sessionKey: "hook:test:123",
      jobName: "Test",
      cleanup: "delete",
      cleanupDelayMinutes: 0,
    });

    markHookRunComplete("test-run");

    // First sweep - RPC fails, entry stays
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
    expect(getHookRun("test-run")).toBeDefined();

    // Second sweep - RPC succeeds, entry removed
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
    expect(getHookRun("test-run")).toBeUndefined();

    clearHookRuns();
  });

  it("does not delete session when cleanup=undefined", async () => {
    const { callGateway } = await import("./call.js");
    const mockCallGateway = vi.mocked(callGateway);

    const { registerHookRun, clearHookRuns } = await import("./hook-run-registry.js");
    clearHookRuns();

    // Register with cleanup=undefined (should be no-op)
    registerHookRun({
      runId: "test-run",
      sessionKey: "hook:test:123",
      jobName: "Test",
      cleanup: undefined,
      cleanupDelayMinutes: undefined,
    });

    // Advance time
    await vi.advanceTimersByTimeAsync(120_000);

    // Verify sessions.delete was NOT called
    expect(mockCallGateway).not.toHaveBeenCalled();

    clearHookRuns();
  });
});
