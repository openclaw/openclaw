import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  coerceToRecord,
  pruneExpiredPending,
  reconcilePendingPairingRequests,
  resolvePairingPaths,
} from "./pairing-files.js";

describe("coerceToRecord", () => {
  it("returns an empty object for null", () => {
    expect(coerceToRecord(null)).toEqual({});
  });

  it("returns an empty object for undefined", () => {
    expect(coerceToRecord(undefined)).toEqual({});
  });

  it("returns an empty object for an array (the #63035 root cause)", () => {
    const result = coerceToRecord<{ id: string }>([]);
    expect(result).toEqual({});
    expect(Array.isArray(result)).toBe(false);

    // Verify the fix: UUID keys survive JSON round-trip on the coerced object
    const uuid = "4bf6458c-631f-44b2-ba9e-d27f3aa96e09";
    result[uuid] = { id: uuid };
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped[uuid]).toEqual({ id: uuid });
  });

  it("returns an empty object for a non-empty array", () => {
    expect(coerceToRecord([1, 2, 3])).toEqual({});
  });

  it("returns an empty object for primitive values", () => {
    expect(coerceToRecord("string")).toEqual({});
    expect(coerceToRecord(42)).toEqual({});
    expect(coerceToRecord(true)).toEqual({});
  });

  it("passes through a plain object unchanged", () => {
    const obj = { key: { name: "value" } };
    expect(coerceToRecord(obj)).toBe(obj);
  });

  it("passes through an empty object unchanged", () => {
    const obj = {};
    expect(coerceToRecord(obj)).toBe(obj);
  });
});

describe("pairing file helpers", () => {
  it("resolves pairing file paths from explicit base dirs", () => {
    expect(resolvePairingPaths("/tmp/openclaw-state", "devices")).toEqual({
      dir: path.join("/tmp/openclaw-state", "devices"),
      pendingPath: path.join("/tmp/openclaw-state", "devices", "pending.json"),
      pairedPath: path.join("/tmp/openclaw-state", "devices", "paired.json"),
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

  it("refreshes a single matching pending request in place", async () => {
    const persist = vi.fn(async () => undefined);
    const existing = { requestId: "req-1", deviceId: "device-1", ts: 1, version: 1 };
    const pendingById = { "req-1": existing };

    await expect(
      reconcilePendingPairingRequests({
        pendingById,
        existing: [existing],
        incoming: { version: 2 },
        canRefreshSingle: () => true,
        refreshSingle: (pending, incoming) => ({ ...pending, version: incoming.version, ts: 2 }),
        buildReplacement: vi.fn(() => ({ requestId: "req-2", deviceId: "device-1", ts: 2 })),
        persist,
      }),
    ).resolves.toEqual({
      status: "pending",
      request: { requestId: "req-1", deviceId: "device-1", ts: 2, version: 2 },
      created: false,
    });
    expect(persist).toHaveBeenCalledOnce();
  });

  it("replaces existing pending requests with one merged request", async () => {
    const persist = vi.fn(async () => undefined);
    const pendingById = {
      "req-1": { requestId: "req-1", deviceId: "device-2", ts: 1 },
      "req-2": { requestId: "req-2", deviceId: "device-2", ts: 2 },
    };

    await expect(
      reconcilePendingPairingRequests({
        pendingById,
        existing: Object.values(pendingById).toSorted((left, right) => right.ts - left.ts),
        incoming: { deviceId: "device-2" },
        canRefreshSingle: () => false,
        refreshSingle: (pending) => pending,
        buildReplacement: vi.fn(() => ({
          requestId: "req-3",
          deviceId: "device-2",
          ts: 3,
          isRepair: true,
        })),
        persist,
      }),
    ).resolves.toEqual({
      status: "pending",
      request: { requestId: "req-3", deviceId: "device-2", ts: 3, isRepair: true },
      created: true,
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(pendingById).toEqual({
      "req-3": { requestId: "req-3", deviceId: "device-2", ts: 3, isRepair: true },
    });
  });
});
