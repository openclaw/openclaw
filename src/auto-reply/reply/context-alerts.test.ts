import { describe, expect, it } from "vitest";
import { buildContextAlertMessage, evaluateContextAlert } from "./context-alerts.js";

describe("evaluateContextAlert", () => {
  it("triggers at 85% when crossing upward", () => {
    const out = evaluateContextAlert({
      usedTokens: 85,
      contextTokens: 100,
      previousLevel: 0,
      now: 1_000,
    });
    expect(out).toEqual({ nextLevel: 85, shouldAlert: true, alertLevel: 85 });
  });

  it("triggers at 95% when crossing upward", () => {
    const out = evaluateContextAlert({
      usedTokens: 95,
      contextTokens: 100,
      previousLevel: 85,
      previousAt: 0,
      now: 31 * 60 * 1000,
    });
    expect(out).toEqual({ nextLevel: 95, shouldAlert: true, alertLevel: 95 });
  });

  it("suppresses repeated same-level alerts during cooldown", () => {
    const out = evaluateContextAlert({
      usedTokens: 86,
      contextTokens: 100,
      previousLevel: 85,
      previousAt: 10_000,
      now: 20_000,
      cooldownMs: 30_000,
    });
    expect(out).toEqual({ nextLevel: 85, shouldAlert: false, alertLevel: null });
  });

  it("alerts on 85% to 95% escalation even during cooldown", () => {
    const out = evaluateContextAlert({
      usedTokens: 96,
      contextTokens: 100,
      previousLevel: 85,
      previousAt: 10_000,
      now: 20_000,
      cooldownMs: 30_000,
    });
    expect(out).toEqual({ nextLevel: 95, shouldAlert: true, alertLevel: 95 });
  });

  it("re-alerts at the same level after cooldown elapses", () => {
    const out = evaluateContextAlert({
      usedTokens: 86,
      contextTokens: 100,
      previousLevel: 85,
      previousAt: 0,
      now: 31_000,
      cooldownMs: 30_000,
    });
    expect(out).toEqual({ nextLevel: 85, shouldAlert: true, alertLevel: 85 });
  });

  it("re-arms 85% alert after dropping below hysteresis and crossing again", () => {
    const dropped = evaluateContextAlert({
      usedTokens: 79,
      contextTokens: 100,
      previousLevel: 85,
      previousAt: 0,
      now: 1_000,
    });
    expect(dropped.nextLevel).toBe(0);

    const recross = evaluateContextAlert({
      usedTokens: 86,
      contextTokens: 100,
      previousLevel: dropped.nextLevel,
      previousAt: 0,
      now: 40 * 60 * 1000,
    });
    expect(recross).toEqual({ nextLevel: 85, shouldAlert: true, alertLevel: 85 });
  });

  it("returns no alert when usage data is unavailable", () => {
    const out = evaluateContextAlert({
      usedTokens: undefined,
      contextTokens: 100,
      previousLevel: 0,
    });
    expect(out).toEqual({ nextLevel: 0, shouldAlert: false, alertLevel: null });
  });
});

describe("buildContextAlertMessage", () => {
  it("formats 85% warning", () => {
    const text = buildContextAlertMessage({
      level: 85,
      usedTokens: 340_000,
      contextTokens: 400_000,
    });
    expect(text).toContain("85%");
    expect(text).toContain("/compact");
  });

  it("formats 95% warning", () => {
    const text = buildContextAlertMessage({
      level: 95,
      usedTokens: 390_000,
      contextTokens: 400_000,
    });
    expect(text).toContain("98%");
    expect(text).toContain("may overflow");
  });
});
