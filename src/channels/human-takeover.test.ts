import { afterEach, describe, expect, it } from "vitest";
import {
  decideHumanTakeover,
  resetHumanTakeoverState,
  resolveHumanTakeoverConfig,
} from "./human-takeover.js";

describe("human takeover", () => {
  afterEach(() => {
    resetHumanTakeoverState();
  });

  it("resolves disabled by default", () => {
    expect(resolveHumanTakeoverConfig({})).toEqual({
      enabled: false,
      cooldownMs: 300_000,
    });
  });

  it("activates cooldown on owner non-command message", () => {
    const decision = decideHumanTakeover({
      sessionKey: "session-a",
      enabled: true,
      cooldownMs: 60_000,
      isOwnerMessage: true,
      nowMs: 1_000,
    });
    expect(decision.skipAutoReply).toBe(true);
    expect(decision.activated).toBe(true);

    const activeDecision = decideHumanTakeover({
      sessionKey: "session-a",
      enabled: true,
      cooldownMs: 60_000,
      isOwnerMessage: false,
      nowMs: 10_000,
    });
    expect(activeDecision.skipAutoReply).toBe(true);
    expect(activeDecision.reason).toBe("cooldown-active");
  });

  it("does not activate on owner command messages", () => {
    const decision = decideHumanTakeover({
      sessionKey: "session-b",
      enabled: true,
      cooldownMs: 60_000,
      isOwnerMessage: true,
      isCommandLike: true,
      nowMs: 1_000,
    });
    expect(decision.skipAutoReply).toBe(false);

    const followUp = decideHumanTakeover({
      sessionKey: "session-b",
      enabled: true,
      cooldownMs: 60_000,
      isOwnerMessage: false,
      nowMs: 2_000,
    });
    expect(followUp.skipAutoReply).toBe(false);
  });
});
