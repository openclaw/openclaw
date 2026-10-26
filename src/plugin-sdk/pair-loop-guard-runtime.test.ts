import { expect, it } from "vitest";
import * as sdk from "./pair-loop-guard-runtime.js";

const settings: sdk.PairLoopGuardSettings = {
  enabled: true,
  maxEventsPerWindow: 3,
  windowMs: 60_000,
  cooldownMs: 5_000,
};
function fixture(overrides: Partial<sdk.PairLoopGuardSettings> = {}) {
  const guard = sdk.createPairLoopGuard();
  const record = (event: Partial<Parameters<typeof guard.recordAndCheck>[0]>) =>
    guard.recordAndCheck({
      scopeId: "scope",
      conversationId: "chat",
      senderId: "a",
      receiverId: "b",
      settings: { ...settings, ...overrides },
      ...event,
    });
  const check = (event: Parameters<typeof record>[0], suppressed = false) =>
    expect(record(event)).toEqual(
      suppressed
        ? { suppressed: true, cooldownUntilMs: event.nowMs! + settings.cooldownMs }
        : { suppressed: false },
    );
  return { guard, record, check };
}

it("shares the window budget between both directions of a pair", () => {
  const { check } = fixture();
  check({ nowMs: 1_000 });
  check({ senderId: "b", receiverId: "a", nowMs: 1_010 });
  check({ nowMs: 1_020 });
  check({ senderId: "b", receiverId: "a", nowMs: 1_030 }, true);
});

it("keeps scopes and conversations independent", () => {
  const { record, check } = fixture();
  for (let index = 0; index <= settings.maxEventsPerWindow; index++) {
    record({ nowMs: 1_000 + index });
  }
  check({ conversationId: "other-chat" });
  check({ scopeId: "other-scope" });
});

it("does not double-count retries before or during cooldown", () => {
  const { check } = fixture({ maxEventsPerWindow: 1 });
  check({ eventId: "first", nowMs: 1_000 });
  check({ eventId: "first", nowMs: 1_000 });
  check({ eventId: "second", nowMs: 1_001 }, true);
  check({ eventId: "second", nowMs: 1_001 }, true);
});

it("does not retain distinct suppressed event identities during cooldown", () => {
  const { guard, record, check } = fixture({ maxEventsPerWindow: 1 });
  check({ eventId: "first", nowMs: 1_000 });
  expect(record({ eventId: "second", nowMs: 1_001 }).suppressed).toBe(true);
  for (let index = 0; index < 1_000; index++) {
    expect(record({ eventId: `suppressed-${index}`, nowMs: 1_002 + index }).suppressed).toBe(true);
  }
  expect(guard.snapshot()).toEqual([
    expect.objectContaining({ recentCount: 0, cooldownUntilMs: 1_001 + settings.cooldownMs }),
  ]);
});

it("uses each pair's own window when pruning inactive entries", () => {
  const { guard, record } = fixture();
  record({ settings: { ...settings, windowMs: 120_000 }, nowMs: 1_000 });
  record({ senderId: "c", receiverId: "d", nowMs: 61_001 });
  expect(guard.snapshot()).toHaveLength(2);
});

it.each([
  { times: [120_000, 0, 120_500], suppressed: [false, false, true] },
  { times: [120_000, 120_500, 0], suppressed: [false, true, false] },
])("ignores future state: $times", ({ times, suppressed }) => {
  const { check } = fixture({ maxEventsPerWindow: 1 });
  times.forEach((nowMs, index) => check({ nowMs }, suppressed[index]));
});

it("does not track disabled, invalid, or self-pair events", () => {
  const { guard, check } = fixture();
  check({ settings: { ...settings, enabled: false } });
  check({ conversationId: "" });
  check({ receiverId: "a" });
  expect(guard.snapshot()).toEqual([]);
});

it("merges explicit false, ignores undefined fields, and preserves absent config", () => {
  expect(sdk.mergePairLoopGuardConfig({ enabled: false }, { windowSeconds: undefined })).toEqual({
    enabled: false,
  });
  expect(sdk.mergePairLoopGuardConfig(undefined, undefined)).toBeUndefined();
});

it("resolves field-by-field overrides and converts seconds to milliseconds", () =>
  expect(
    sdk.resolvePairLoopGuardSettings({
      config: { maxEventsPerWindow: 4, windowSeconds: 10 },
      defaultsConfig: { maxEventsPerWindow: 8, windowSeconds: 120, cooldownSeconds: 30 },
      defaultEnabled: true,
    }),
  ).toEqual({ enabled: true, maxEventsPerWindow: 4, windowMs: 10_000, cooldownMs: 30_000 }));

it.each(["channel", "defaults"] as const)("honors enabled=false from %s", (source) =>
  expect(
    sdk.resolvePairLoopGuardSettings({
      config: source === "channel" ? { enabled: false } : undefined,
      defaultsConfig: { enabled: source === "channel" },
      defaultEnabled: true,
    }).enabled,
  ).toBe(false),
);

it("uses built-in defaults for invalid numbers", () =>
  expect(
    sdk.resolvePairLoopGuardSettings({
      config: { maxEventsPerWindow: 0, windowSeconds: -1, cooldownSeconds: -5 },
      defaultEnabled: true,
    }),
  ).toEqual(sdk.DEFAULT_PAIR_LOOP_GUARD_SETTINGS));
