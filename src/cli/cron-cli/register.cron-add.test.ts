// Authored by: cc (Claude Code) | 2026-03-20
import { describe, expect, it } from "vitest";
import { resolveDeliveryConfig } from "./register.cron-add.js";

describe("resolveDeliveryConfig — script delivery flags wiring", () => {
  it("returns announce delivery for script job with --announce", () => {
    const result = resolveDeliveryConfig({
      payloadKind: "script",
      isIsolatedLike: true,
      hasAnnounce: true,
      hasNoDeliver: false,
      channel: "telegram",
      to: "12345",
      accountId: "acc1",
      bestEffortDeliver: true,
    });
    expect(result).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "12345",
      accountId: "acc1",
      bestEffort: true,
    });
  });

  it("returns none delivery for script job with --no-deliver", () => {
    const result = resolveDeliveryConfig({
      payloadKind: "script",
      isIsolatedLike: true,
      hasAnnounce: false,
      hasNoDeliver: true,
    });
    expect(result).toEqual({
      mode: "none",
      channel: undefined,
      to: undefined,
      accountId: undefined,
      bestEffort: undefined,
    });
  });

  it("returns undefined for script job without --announce or --no-deliver", () => {
    const result = resolveDeliveryConfig({
      payloadKind: "script",
      isIsolatedLike: true,
      hasAnnounce: false,
      hasNoDeliver: false,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for script job when not isolated", () => {
    const result = resolveDeliveryConfig({
      payloadKind: "script",
      isIsolatedLike: false,
      hasAnnounce: true,
      hasNoDeliver: false,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for systemEvent regardless of announce flag", () => {
    const result = resolveDeliveryConfig({
      payloadKind: "systemEvent",
      isIsolatedLike: true,
      hasAnnounce: true,
      hasNoDeliver: false,
    });
    expect(result).toBeUndefined();
  });

  it("defaults agentTurn to announce without --announce flag", () => {
    const result = resolveDeliveryConfig({
      payloadKind: "agentTurn",
      isIsolatedLike: true,
      hasAnnounce: false,
      hasNoDeliver: false,
    });
    expect(result?.mode).toBe("announce");
  });

  it("trims whitespace from channel and to fields", () => {
    const result = resolveDeliveryConfig({
      payloadKind: "script",
      isIsolatedLike: true,
      hasAnnounce: true,
      hasNoDeliver: false,
      channel: "  telegram  ",
      to: "  12345  ",
    });
    expect(result?.channel).toBe("telegram");
    expect(result?.to).toBe("12345");
  });
});
