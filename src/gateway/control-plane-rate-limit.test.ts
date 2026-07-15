// Covers control-plane write rate-limit windows, stale bucket pruning, and
// hard bucket cap behavior.
import { afterEach, describe, expect, test } from "vitest";
import {
  consumeControlPlaneWriteBudget,
  pruneStaleControlPlaneBuckets,
  resolveControlPlaneWriteBudgetMaxRequests,
} from "./control-plane-rate-limit.js";

describe("control-plane-rate-limit", () => {
  afterEach(() => {
    pruneStaleControlPlaneBuckets(Number.MAX_SAFE_INTEGER);
  });

  test("pruneStaleControlPlaneBuckets removes expired buckets (#63643)", () => {
    // Create buckets at different times
    const baseMs = 1_000_000;
    consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-old" } }, clientIp: "1.2.3.4" } as never,
      nowMs: baseMs,
    });
    consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-recent" } }, clientIp: "5.6.7.8" } as never,
      nowMs: baseMs + 4 * 60_000,
    });

    // Prune at baseMs + 6 minutes — "dev-old" is > 5 min stale, "dev-recent" is only 2 min
    const pruned = pruneStaleControlPlaneBuckets(baseMs + 6 * 60_000);
    expect(pruned).toBe(1);

    // "dev-recent" should still have budget
    const result = consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-recent" } }, clientIp: "5.6.7.8" } as never,
      nowMs: baseMs + 6 * 60_000,
    });
    expect(result.allowed).toBe(true);
  });

  test("pruneStaleControlPlaneBuckets is safe on empty map", () => {
    expect(pruneStaleControlPlaneBuckets()).toBe(0);
  });

  test("control-plane bucket map evicts the oldest identity at its hard cap", () => {
    const baseMs = 2_000_000;
    const consume = (id: string) =>
      consumeControlPlaneWriteBudget({
        client: {
          connect: { device: { id } },
          clientIp: "1.2.3.4",
        } as never,
        nowMs: baseMs,
      });

    expect(consume("oldest").allowed).toBe(true);
    expect(consume("oldest").allowed).toBe(true);
    expect(consume("oldest").allowed).toBe(true);
    expect(consume("oldest").allowed).toBe(false);

    for (let index = 0; index < 10_000; index += 1) {
      consume(`new-${index}`);
    }

    // A fresh budget proves the oldest bucket was evicted, without exposing
    // the internal map solely for tests.
    expect(consume("oldest")).toMatchObject({ allowed: true, remaining: 2 });
  });

  test("consumeControlPlaneWriteBudget honors a configured maxRequests", () => {
    const baseMs = 3_000_000;
    const consume = () =>
      consumeControlPlaneWriteBudget({
        client: { connect: { device: { id: "dev-dial" } }, clientIp: "9.9.9.9" } as never,
        nowMs: baseMs,
        maxRequests: 5,
      });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(consume()).toMatchObject({ allowed: true, maxRequests: 5 });
    }
    const blocked = consume();
    expect(blocked.allowed).toBe(false);
    expect(blocked.maxRequests).toBe(5);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("consumeControlPlaneWriteBudget keeps the 3-per-window default", () => {
    const baseMs = 4_000_000;
    const consume = () =>
      consumeControlPlaneWriteBudget({
        client: { connect: { device: { id: "dev-default" } }, clientIp: "8.8.8.8" } as never,
        nowMs: baseMs,
      });

    expect(consume()).toMatchObject({ allowed: true, maxRequests: 3, remaining: 2 });
    consume();
    consume();
    expect(consume().allowed).toBe(false);
  });

  test("resolveControlPlaneWriteBudgetMaxRequests reads gateway config with a default of 3", () => {
    expect(resolveControlPlaneWriteBudgetMaxRequests(undefined)).toBe(3);
    expect(resolveControlPlaneWriteBudgetMaxRequests({})).toBe(3);
    expect(
      resolveControlPlaneWriteBudgetMaxRequests({
        gateway: { controlPlaneWritesPerMinute: 60 },
      }),
    ).toBe(60);
  });
});
