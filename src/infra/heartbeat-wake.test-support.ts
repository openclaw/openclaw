import { expect, vi } from "vitest";
import {
  requestHeartbeat,
  setHeartbeatWakeHandler,
  type HeartbeatWakeRequest,
} from "./heartbeat-wake.js";

export async function drainPendingHeartbeatWakesForTest(): Promise<void> {
  const handler = vi.fn(async (_request: HeartbeatWakeRequest) => ({
    status: "ran" as const,
    durationMs: 0,
  }));
  const dispose = setHeartbeatWakeHandler(handler);
  try {
    requestHeartbeat({
      source: "other",
      intent: "immediate",
      reason: "test-cleanup",
      coalesceMs: 0,
    });
    await expect
      .poll(() => handler.mock.calls.some(([request]) => request.reason === "test-cleanup"), {
        timeout: 5_000,
        interval: 10,
      })
      .toBe(true);
  } finally {
    dispose();
  }
}
