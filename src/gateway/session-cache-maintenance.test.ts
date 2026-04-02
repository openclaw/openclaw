import { describe, expect, it } from "vitest";
import {
  shouldResetExpiredSession,
  shouldRunIdleCacheCompaction,
} from "./session-cache-maintenance.js";

const ONE_HOUR_MS = 60 * 60_000;
const ONE_MINUTE_MS = 60_000;

describe("session cache maintenance helpers", () => {
  it("warms idle long sessions shortly before cache expiry", () => {
    expect(
      shouldRunIdleCacheCompaction({
        entry: {
          lastUserMessageAt: 1_000,
          lastAssistantMessageAt: 2_000,
          lastCacheTouchAt: 2_000,
        },
        policy: {
          mode: "compact",
          cacheTtlMs: ONE_HOUR_MS,
          idleCompactionMinTokens: 20_000,
          idleCompactionLeadMs: ONE_MINUTE_MS,
        },
        now: 2_000 + ONE_HOUR_MS - ONE_MINUTE_MS,
        totalTokens: 25_000,
      }),
    ).toBe(true);
  });

  it("does not warm when the current assistant idle window was already serviced", () => {
    expect(
      shouldRunIdleCacheCompaction({
        entry: {
          lastUserMessageAt: 1_000,
          lastAssistantMessageAt: 2_000,
          lastCacheTouchAt: 2_000,
          lastIdleCompactionForAssistantMessageAt: 2_000,
        },
        policy: {
          mode: "compact",
          cacheTtlMs: ONE_HOUR_MS,
          idleCompactionMinTokens: 20_000,
          idleCompactionLeadMs: ONE_MINUTE_MS,
        },
        now: 2_000 + ONE_HOUR_MS - ONE_MINUTE_MS,
        totalTokens: 25_000,
      }),
    ).toBe(false);
  });

  it("still treats equal user and assistant timestamps as awaiting user reply", () => {
    expect(
      shouldRunIdleCacheCompaction({
        entry: {
          lastUserMessageAt: 2_000,
          lastAssistantMessageAt: 2_000,
          lastCacheTouchAt: 2_000,
        },
        policy: {
          mode: "compact",
          cacheTtlMs: ONE_HOUR_MS,
          idleCompactionMinTokens: 20_000,
          idleCompactionLeadMs: ONE_MINUTE_MS,
        },
        now: 2_000 + ONE_HOUR_MS - ONE_MINUTE_MS,
        totalTokens: 25_000,
      }),
    ).toBe(true);
  });

  it("does not warm short sessions below the default token floor", () => {
    expect(
      shouldRunIdleCacheCompaction({
        entry: {
          lastUserMessageAt: 1_000,
          lastAssistantMessageAt: 2_000,
          lastCacheTouchAt: 2_000,
        },
        policy: {
          mode: "compact",
          cacheTtlMs: ONE_HOUR_MS,
          idleCompactionMinTokens: 20_000,
          idleCompactionLeadMs: ONE_MINUTE_MS,
        },
        now: 2_000 + ONE_HOUR_MS - ONE_MINUTE_MS,
        totalTokens: 19_999,
      }),
    ).toBe(false);
  });

  it("resets expired sessions once cache ttl is exceeded", () => {
    expect(
      shouldResetExpiredSession({
        entry: {
          lastUserMessageAt: 1_000,
          lastAssistantMessageAt: 2_000,
          lastCacheTouchAt: 2_000,
        },
        policy: {
          mode: "reset",
          cacheTtlMs: ONE_HOUR_MS,
          idleCompactionMinTokens: 20_000,
          idleCompactionLeadMs: ONE_MINUTE_MS,
        },
        now: 2_000 + ONE_HOUR_MS,
      }),
    ).toBe(true);
  });

  it("does not reset while waiting on a newer user message", () => {
    expect(
      shouldResetExpiredSession({
        entry: {
          lastUserMessageAt: 3_000,
          lastAssistantMessageAt: 2_000,
          lastCacheTouchAt: 2_000,
        },
        policy: {
          mode: "reset",
          cacheTtlMs: ONE_HOUR_MS,
          idleCompactionMinTokens: 20_000,
          idleCompactionLeadMs: ONE_MINUTE_MS,
        },
        now: 2_000 + ONE_HOUR_MS,
      }),
    ).toBe(false);
  });

  it("does not reset in compact mode", () => {
    expect(
      shouldResetExpiredSession({
        entry: {
          lastUserMessageAt: 1_000,
          lastAssistantMessageAt: 2_000,
          lastCacheTouchAt: 2_000,
        },
        policy: {
          mode: "compact",
          cacheTtlMs: ONE_HOUR_MS,
          idleCompactionMinTokens: 20_000,
          idleCompactionLeadMs: ONE_MINUTE_MS,
        },
        now: 2_000 + ONE_HOUR_MS,
      }),
    ).toBe(false);
  });

  it("does not compact in reset mode", () => {
    expect(
      shouldRunIdleCacheCompaction({
        entry: {
          lastUserMessageAt: 1_000,
          lastAssistantMessageAt: 2_000,
          lastCacheTouchAt: 2_000,
        },
        policy: {
          mode: "reset",
          cacheTtlMs: ONE_HOUR_MS,
          idleCompactionMinTokens: 20_000,
          idleCompactionLeadMs: ONE_MINUTE_MS,
        },
        now: 2_000 + ONE_HOUR_MS - ONE_MINUTE_MS,
        totalTokens: 25_000,
      }),
    ).toBe(false);
  });
});
