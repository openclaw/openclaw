import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  pruneExpiredPending,
  resolvePairingPaths,
  upsertPendingPairingRequest,
} from "./pairing-files.js";

describe("pairing file helpers", () => {
  it("resolves pairing file paths from explicit base dirs", () => {
    const dir = path.join("/tmp/openclaw-state", "devices");
    expect(resolvePairingPaths("/tmp/openclaw-state", "devices")).toEqual({
      dir,
      pendingPath: path.join(dir, "pending.json"),
      pairedPath: path.join(dir, "paired.json"),
    });
  });

  it("prunes only entries older than the ttl", () => {
    const pendingById = {
      stale: { ts: 10, requestId: "stale" },
      edge: { ts: 50, requestId: "edge" },
      fresh: { ts: 70, requestId: "fresh" },
    };

    pruneExpiredPending(pendingById, 100, 50);

    expect(pendingById).toEqual({
      edge: { ts: 50, requestId: "edge" },
      fresh: { ts: 70, requestId: "fresh" },
    });
  });

  it("reuses existing pending requests without persisting again", async () => {
    const persist = vi.fn(async () => undefined);
    const existing = { requestId: "req-1", deviceId: "device-1", ts: 1 };
    const pendingById = { "req-1": existing };

    await expect(
      upsertPendingPairingRequest({
        pendingById,
        isExisting: (pending) => pending.deviceId === "device-1",
        createRequest: vi.fn(() => ({ requestId: "req-2", deviceId: "device-1", ts: 2 })),
        isRepair: false,
        persist,
      }),
    ).resolves.toEqual({
      status: "pending",
      request: existing,
      created: false,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("creates and persists new pending requests with the repair flag", async () => {
    const persist = vi.fn(async () => undefined);
    const createRequest = vi.fn((isRepair: boolean) => ({
      requestId: "req-2",
      deviceId: "device-2",
      ts: 2,
      isRepair,
    }));
    const pendingById: Record<
      string,
      { requestId: string; deviceId: string; ts: number; isRepair: boolean }
    > = {};

    await expect(
      upsertPendingPairingRequest({
        pendingById,
        isExisting: (pending) => pending.deviceId === "device-2",
        createRequest,
        isRepair: true,
        persist,
      }),
    ).resolves.toEqual({
      status: "pending",
      request: { requestId: "req-2", deviceId: "device-2", ts: 2, isRepair: true },
      created: true,
    });
    expect(createRequest).toHaveBeenCalledWith(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(pendingById).toEqual({
      "req-2": { requestId: "req-2", deviceId: "device-2", ts: 2, isRepair: true },
    });
  });
});
