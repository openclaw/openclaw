import { expectTypeOf, it } from "vitest";
import type {
  resolveSessionEntryResetFreshness,
  resolveSessionEntryResetFreshnessAsync,
} from "../config/sessions/entry-freshness.js";

type ReleasedFreshness = typeof resolveSessionEntryResetFreshness;
type AsyncFreshness = typeof resolveSessionEntryResetFreshnessAsync;

it("retains the released synchronous session reset freshness contract", () => {
  expectTypeOf<ReleasedFreshness>().toBeCallableWith({
    agentId: "main",
    storePath: "/synthetic/sessions.sqlite",
    sessionKey: "agent:main:thread:123",
    sessionCfg: { reset: { mode: "idle", idleMinutes: 30 } },
    resetType: "thread",
    resetOverride: { mode: "daily", atHour: 4 },
    now: 1_000,
  });
  expectTypeOf<ReturnType<ReleasedFreshness>["state"]>().toEqualTypeOf<
    "missing" | "fresh" | "stale"
  >();
  expectTypeOf<ReturnType<ReleasedFreshness>["lifecycleTimestamps"]>().toEqualTypeOf<{
    sessionStartedAt?: number;
    lastInteractionAt?: number;
  }>();
  expectTypeOf<Parameters<AsyncFreshness>>().toEqualTypeOf<Parameters<ReleasedFreshness>>();
  expectTypeOf<ReturnType<AsyncFreshness>>().toEqualTypeOf<
    Promise<ReturnType<ReleasedFreshness>>
  >();
});
