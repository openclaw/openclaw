import { describe, expect, it } from "vitest";
import {
  createPairLoopGuard,
  DEFAULT_PAIR_LOOP_GUARD_SETTINGS,
  mergePairLoopGuardConfig,
  resolvePairLoopGuardSettings,
  type PairLoopGuardSettings,
} from "./pair-loop-guard-runtime.js";

const settings: PairLoopGuardSettings = {
  enabled: true,
  maxEventsPerWindow: 3,
  windowMs: 60_000,
  cooldownMs: 5_000,
};

const base = {
  scopeId: "scope-1",
  conversationId: "conversation-1",
  senderId: "participant-a",
  receiverId: "participant-b",
  settings,
};

function createFixture(overrides: Partial<PairLoopGuardSettings> = {}) {
  const guard = createPairLoopGuard();
  const fixtureSettings = { ...settings, ...overrides };
  const record = (event: Partial<Parameters<typeof guard.recordAndCheck>[0]>) =>
    guard.recordAndCheck({ ...base, settings: fixtureSettings, ...event });
  return { guard, record };
}

describe("createPairLoopGuard", () => {
  it("suppresses either direction once a participant pair exceeds the window budget", () => {
    const { record } = createFixture();

    expect(record({ nowMs: 1_000 })).toEqual({ suppressed: false });
    expect(
      record({ senderId: "participant-b", receiverId: "participant-a", nowMs: 1_010 }),
    ).toEqual({ suppressed: false });
    expect(record({ nowMs: 1_020 })).toEqual({ suppressed: false });

    const result = record({ senderId: "participant-b", receiverId: "participant-a", nowMs: 1_030 });

    expect(result).toEqual({ suppressed: true, cooldownUntilMs: 1_030 + settings.cooldownMs });
  });

  it("keeps scopes and conversations independent", () => {
    const { record } = createFixture();

    for (let index = 0; index < settings.maxEventsPerWindow + 1; index += 1) {
      record({ nowMs: 1_000 + index });
    }

    expect(record({ conversationId: "conversation-2" })).toEqual({ suppressed: false });
    expect(record({ scopeId: "scope-2" })).toEqual({ suppressed: false });
  });

  it("does not consume another budget slot when the same event is retried", () => {
    const { record } = createFixture({ maxEventsPerWindow: 1 });

    expect(record({ eventId: "event-1", nowMs: 1_000 })).toEqual({ suppressed: false });
    expect(record({ eventId: "event-1", nowMs: 1_000 })).toEqual({ suppressed: false });
    const second = record({ eventId: "event-2", nowMs: 1_001 });
    expect(second).toEqual({
      suppressed: true,
      cooldownUntilMs: 1_001 + settings.cooldownMs,
    });
    expect(record({ eventId: "event-2", nowMs: 1_001 })).toEqual(second);
  });

  it("does not retain distinct suppressed event identities during cooldown", () => {
    const { guard, record } = createFixture({ maxEventsPerWindow: 1 });

    expect(record({ eventId: "event-1", nowMs: 1_000 })).toEqual({ suppressed: false });
    expect(record({ eventId: "event-2", nowMs: 1_001 }).suppressed).toBe(true);
    for (let index = 0; index < 1_000; index += 1) {
      expect(
        record({
          eventId: `suppressed-${index}`,
          nowMs: 1_002 + index,
        }).suppressed,
      ).toBe(true);
    }

    expect(guard.snapshot()).toEqual([
      expect.objectContaining({
        recentCount: 0,
        cooldownUntilMs: 1_001 + settings.cooldownMs,
      }),
    ]);
  });

  it("uses each tracked pair's own window when pruning inactive entries", () => {
    const { guard, record } = createFixture();
    const longWindowSettings = { ...settings, windowMs: 120_000 };

    record({ settings: longWindowSettings, nowMs: 1_000 });
    record({ senderId: "participant-c", receiverId: "participant-d", nowMs: 61_001 });

    expect(guard.snapshot()).toHaveLength(2);
  });

  it("does not count future event timestamps against older reordered events", () => {
    const { record } = createFixture({ maxEventsPerWindow: 1 });

    expect(record({ nowMs: 120_000 })).toEqual({ suppressed: false });
    expect(record({ nowMs: 0 })).toEqual({ suppressed: false });
    expect(record({ nowMs: 120_500 })).toEqual({
      suppressed: true,
      cooldownUntilMs: 120_500 + settings.cooldownMs,
    });
  });

  it("does not apply a future cooldown to an older reordered event", () => {
    const { record } = createFixture({ maxEventsPerWindow: 1 });

    expect(record({ nowMs: 120_000 })).toEqual({ suppressed: false });
    expect(record({ nowMs: 120_500 })).toEqual({
      suppressed: true,
      cooldownUntilMs: 120_500 + settings.cooldownMs,
    });
    expect(record({ nowMs: 0 })).toEqual({ suppressed: false });
  });

  it("does not track disabled, invalid, or self-pair events", () => {
    const { guard, record } = createFixture();

    expect(record({ settings: { ...settings, enabled: false } })).toEqual({ suppressed: false });
    expect(record({ conversationId: "" })).toEqual({ suppressed: false });
    expect(record({ receiverId: "participant-a" })).toEqual({ suppressed: false });
    expect(guard.snapshot()).toEqual([]);
  });
});

describe("mergePairLoopGuardConfig", () => {
  it("preserves explicit false and ignores undefined override fields", () => {
    expect(mergePairLoopGuardConfig({ enabled: false }, { windowSeconds: undefined })).toEqual({
      enabled: false,
    });
    expect(mergePairLoopGuardConfig(undefined, undefined)).toBeUndefined();
  });
});

describe("resolvePairLoopGuardSettings", () => {
  it("lets channel config override shared channel defaults field-by-field", () => {
    const resolved = resolvePairLoopGuardSettings({
      config: { maxEventsPerWindow: 4, windowSeconds: 10 },
      defaultsConfig: { maxEventsPerWindow: 8, windowSeconds: 120, cooldownSeconds: 30 },
      defaultEnabled: true,
    });

    expect(resolved).toEqual({
      enabled: true,
      maxEventsPerWindow: 4,
      windowMs: 10_000,
      cooldownMs: 30_000,
    });
  });

  it.each(["channel", "defaults"] as const)("honors enabled=false from %s", (source) => {
    expect(
      resolvePairLoopGuardSettings({
        config: source === "channel" ? { enabled: false } : undefined,
        defaultsConfig: { enabled: source === "channel" },
        defaultEnabled: true,
      }).enabled,
    ).toBe(false);
  });

  it("falls back to built-in defaults for invalid numeric config", () => {
    expect(
      resolvePairLoopGuardSettings({
        config: { maxEventsPerWindow: 0, windowSeconds: -1, cooldownSeconds: -5 },
        defaultEnabled: true,
      }),
    ).toEqual(DEFAULT_PAIR_LOOP_GUARD_SETTINGS);
  });
});
