import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestHeartbeatNow, setHeartbeatWakeHandler } from "./heartbeat-wake.js";

describe("Heartbeat Wake Coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setHeartbeatWakeHandler(null);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("processes all unique session keys when requests are coalesced", async () => {
    // Setup a handler that resolves successfully
    const handler = vi.fn().mockResolvedValue({ status: "ran" as const, durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    // Call requestHeartbeatNow multiple times with different session keys
    // within the default coalesce window (250ms)
    requestHeartbeatNow({ reason: "exec-1", sessionKey: "session-A" });
    requestHeartbeatNow({ reason: "exec-2", sessionKey: "session-B" });

    // Advance time past the coalesce window
    await vi.advanceTimersByTimeAsync(300);

    // Collect all sessionKeys passed to the handler
    // The handler now receives sessionKeys: string[]
    const calledSessionKeys = handler.mock.calls
      .flatMap((call) => call[0].sessionKeys || [])
      .filter((key): key is string => key !== undefined);

    // Expect both "session-A" and "session-B" to have been processed.
    expect(calledSessionKeys).toContain("session-A");
    expect(calledSessionKeys).toContain("session-B");
    expect(calledSessionKeys.length).toBeGreaterThanOrEqual(2);
  });
});
