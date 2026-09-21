import { afterEach, describe, expect, it, vi } from "vitest";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./registry.js", () => ({ withFleetCellOperationLease: acquire }));

import { withFleetCellOperation } from "./service-support.runtime.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("fleet operation lifecycle", () => {
  it("awaits acquisition, checkpoints, timer renewal, and release before reporting success", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    acquire.mockImplementation(async (_params, operation) => {
      await Promise.resolve();
      events.push("acquired");
      const lease = {
        owner: "fixture-owner",
        heartbeat: async () => {
          await Promise.resolve();
          events.push("renewed");
        },
        release: async () => {
          await Promise.resolve();
          events.push("released");
        },
      };
      try {
        return await operation(lease);
      } finally {
        await lease.release();
      }
    });

    const result = await withFleetCellOperation({
      env: {},
      tenantId: "fixture",
      operationName: "start",
      operation: async (checkpoint) => {
        await checkpoint();
        events.push("effect");
        await vi.advanceTimersByTimeAsync(60_000);
        events.push("completed");
        return "started";
      },
    });

    expect(result).toBe("started");
    expect(events).toEqual([
      "acquired",
      "renewed",
      "effect",
      "renewed",
      "completed",
      "renewed",
      "released",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
