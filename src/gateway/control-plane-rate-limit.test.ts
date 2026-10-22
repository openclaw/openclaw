import { afterEach, describe, expect, test } from "vitest";
import {
  consumeControlPlaneWriteBudget,
  CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
  CONTROL_PLANE_RATE_LIMIT_WINDOW_MS,
  pruneStaleControlPlaneBuckets,
} from "./control-plane-rate-limit.js";

describe("control-plane-rate-limit", () => {
  const client = {
    connect: { device: { id: "dev-1" } },
    clientIp: "1.2.3.4",
  } as never;
  const consume = (method: string, nowMs: number, identity = client) =>
    consumeControlPlaneWriteBudget({ client: identity, method, nowMs });
  const exhaust = (method: string, nowMs: number) => {
    for (let index = 0; index < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; index++) {
      expect(consume(method, nowMs).allowed).toBe(true);
    }
  };
  const device = (id: string, clientIp = "1.2.3.4") =>
    ({ connect: { device: { id } }, clientIp }) as never;

  afterEach(() => {
    pruneStaleControlPlaneBuckets(Number.MAX_SAFE_INTEGER);
  });

  test("pruneStaleControlPlaneBuckets removes expired buckets (#63643)", () => {
    const baseMs = 1_000_000;
    const recent = device("dev-recent", "5.6.7.8");
    consume("config.apply", baseMs, device("dev-old"));
    consume("config.apply", baseMs + 4 * 60_000, recent);

    // Prune at baseMs + 6 minutes — "dev-old" is > 5 min stale, "dev-recent" is only 2 min
    expect(pruneStaleControlPlaneBuckets(baseMs + 6 * 60_000)).toBe(1);
    expect(consume("config.apply", baseMs + 6 * 60_000, recent).allowed).toBe(true);
  });

  test("different methods from the same client use separate buckets", () => {
    exhaust("config.apply", 1_000);
    expect(consume("plugins.setEnabled", 1_000).allowed).toBe(true);
  });

  test("rejects the 31st call of the same method with the correct retry delay", () => {
    const baseMs = 10_000;
    exhaust("config.patch", baseMs);
    expect(consume("config.patch", baseMs + 10_000)).toMatchObject({
      allowed: false,
      retryAfterMs: CONTROL_PLANE_RATE_LIMIT_WINDOW_MS - 10_000,
    });
  });

  test("resets the method budget after the window", () => {
    const baseMs = 20_000;
    exhaust("update.run", baseMs);
    expect(consume("update.run", baseMs + CONTROL_PLANE_RATE_LIMIT_WINDOW_MS)).toMatchObject({
      allowed: true,
      retryAfterMs: 0,
    });
  });

  test("control-plane bucket map evicts the oldest identity at its hard cap", () => {
    const baseMs = 2_000_000;
    const consumeDevice = (id: string) => consume("config.apply", baseMs, device(id));

    expect(consumeDevice("oldest").allowed).toBe(true);
    for (let index = 1; index < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      expect(consumeDevice("oldest").allowed).toBe(true);
    }
    expect(consumeDevice("oldest").allowed).toBe(false);

    for (let index = 0; index < 10_000; index += 1) {
      consumeDevice(`new-${index}`);
    }

    // A fresh budget proves the oldest bucket was evicted, without exposing
    // the internal map solely for tests.
    expect(consumeDevice("oldest").allowed).toBe(true);
  });
});
