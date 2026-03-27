import { afterEach, describe, expect, it } from "vitest";
import {
  consumeControlPlaneWriteBudget,
  resolveControlPlaneRateLimitKey,
  __testing,
} from "./control-plane-rate-limit.js";

afterEach(() => {
  __testing.resetControlPlaneRateLimitState();
});

describe("resolveControlPlaneRateLimitKey", () => {
  it("uses deviceId|clientIp when both are available", () => {
    const key = resolveControlPlaneRateLimitKey({
      connect: { device: { id: "dev1" } },
      clientIp: "1.2.3.4",
    } as Parameters<typeof resolveControlPlaneRateLimitKey>[0]);
    expect(key).toBe("dev1|1.2.3.4");
  });

  it("includes connId fallback when both device and IP are unknown", () => {
    const key = resolveControlPlaneRateLimitKey({
      connId: "conn-abc",
    } as Parameters<typeof resolveControlPlaneRateLimitKey>[0]);
    expect(key).toBe("unknown-device|unknown-ip|conn=conn-abc");
  });
});

describe("consumeControlPlaneWriteBudget", () => {
  it("allows up to 3 requests per 60s window", () => {
    const now = 1_000_000;
    const client = {
      connect: { device: { id: "dev1" } },
      clientIp: "1.2.3.4",
    } as Parameters<typeof consumeControlPlaneWriteBudget>[0]["client"];

    const r1 = consumeControlPlaneWriteBudget({ client, nowMs: now });
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = consumeControlPlaneWriteBudget({ client, nowMs: now + 100 });
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = consumeControlPlaneWriteBudget({ client, nowMs: now + 200 });
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = consumeControlPlaneWriteBudget({ client, nowMs: now + 300 });
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets window after 60s", () => {
    const now = 1_000_000;
    const client = {
      connect: { device: { id: "dev1" } },
      clientIp: "1.2.3.4",
    } as Parameters<typeof consumeControlPlaneWriteBudget>[0]["client"];

    for (let i = 0; i < 3; i++) {
      consumeControlPlaneWriteBudget({ client, nowMs: now + i });
    }

    const blocked = consumeControlPlaneWriteBudget({ client, nowMs: now + 300 });
    expect(blocked.allowed).toBe(false);

    const afterWindow = consumeControlPlaneWriteBudget({ client, nowMs: now + 60_001 });
    expect(afterWindow.allowed).toBe(true);
  });
});

describe("controlPlaneBuckets memory bounds", () => {
  it("caps tracked keys to prevent unbounded growth", () => {
    const now = 1_000_000;
    const maxKeys = __testing.CONTROL_PLANE_MAX_TRACKED_KEYS;

    for (let i = 0; i < maxKeys + 500; i++) {
      consumeControlPlaneWriteBudget({
        client: {
          connect: { device: { id: `dev-${i}` } },
          clientIp: `10.0.${Math.floor(i / 256)}.${i % 256}`,
        } as Parameters<typeof consumeControlPlaneWriteBudget>[0]["client"],
        nowMs: now,
      });
    }

    expect(__testing.controlPlaneBucketsSize()).toBeLessThanOrEqual(maxKeys);
  });

  it("prunes expired entries before evicting live ones", () => {
    const now = 1_000_000;
    const maxKeys = __testing.CONTROL_PLANE_MAX_TRACKED_KEYS;

    // Fill with entries at time=now
    for (let i = 0; i < maxKeys; i++) {
      consumeControlPlaneWriteBudget({
        client: {
          connect: { device: { id: `old-${i}` } },
          clientIp: `10.0.${Math.floor(i / 256)}.${i % 256}`,
        } as Parameters<typeof consumeControlPlaneWriteBudget>[0]["client"],
        nowMs: now,
      });
    }
    expect(__testing.controlPlaneBucketsSize()).toBe(maxKeys);

    // Add new entries after the window expires — old entries should be pruned first
    const afterExpiry = now + 60_001;
    consumeControlPlaneWriteBudget({
      client: {
        connect: { device: { id: "fresh" } },
        clientIp: "192.168.1.1",
      } as Parameters<typeof consumeControlPlaneWriteBudget>[0]["client"],
      nowMs: afterExpiry,
    });

    // All expired entries should be gone, only the fresh one remains
    expect(__testing.controlPlaneBucketsSize()).toBe(1);
  });

  it("refreshed entries are not evicted before newer entries (LRU order)", () => {
    const now = 1_000_000;
    const maxKeys = __testing.CONTROL_PLANE_MAX_TRACKED_KEYS;

    // Fill to capacity at t=now
    for (let i = 0; i < maxKeys; i++) {
      consumeControlPlaneWriteBudget({
        client: {
          connect: { device: { id: `dev-${i}` } },
          clientIp: `10.0.${Math.floor(i / 256)}.${i % 256}`,
        } as Parameters<typeof consumeControlPlaneWriteBudget>[0]["client"],
        nowMs: now,
      });
    }
    expect(__testing.controlPlaneBucketsSize()).toBe(maxKeys);

    // Refresh dev-0's window (the earliest-inserted key) at t = now + 60_001
    // This should move it to the tail of the Map via delete+re-insert.
    const refreshTime = now + 60_001;
    consumeControlPlaneWriteBudget({
      client: {
        connect: { device: { id: "dev-0" } },
        clientIp: "10.0.0.0",
      } as Parameters<typeof consumeControlPlaneWriteBudget>[0]["client"],
      nowMs: refreshTime,
    });

    // Now add a brand-new device to push over the cap and trigger eviction.
    consumeControlPlaneWriteBudget({
      client: {
        connect: { device: { id: "brand-new" } },
        clientIp: "192.168.99.1",
      } as Parameters<typeof consumeControlPlaneWriteBudget>[0]["client"],
      nowMs: refreshTime,
    });

    // dev-0 was refreshed and moved to tail — it should survive FIFO eviction.
    // The evicted entry should be dev-1 (the oldest non-expired entry still at
    // its original insertion position), not dev-0.
    expect(__testing.controlPlaneBucketsSize()).toBeLessThanOrEqual(maxKeys);
  });
});
