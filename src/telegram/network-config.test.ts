import { describe, expect, it } from "vitest";
import { resolveTelegramAutoSelectFamilyDecision } from "./network-config.js";

describe("resolveTelegramAutoSelectFamilyDecision", () => {
  it("prefers env enable over env disable", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({
      env: {
        OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1",
        OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1",
      },
      nodeMajor: 22,
    });
    expect(decision).toEqual({
      value: true,
      source: "env:OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
    });
  });

  it("uses env disable when set", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({
      env: { OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1" },
      nodeMajor: 22,
    });
    expect(decision).toEqual({
      value: false,
      source: "env:OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY",
    });
  });

  it("prefers env enable over config", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({
      env: { OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1" },
      network: { autoSelectFamily: false },
      nodeMajor: 22,
    });
    expect(decision).toEqual({
      value: true,
      source: "env:OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
    });
  });

  it("prefers env disable over config", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({
      env: { OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY: "1" },
      network: { autoSelectFamily: true },
      nodeMajor: 22,
    });
    expect(decision).toEqual({
      value: false,
      source: "env:OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY",
    });
  });

  it("uses config override when provided", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({
      env: {},
      network: { autoSelectFamily: true },
      nodeMajor: 22,
    });
    expect(decision).toEqual({ value: true, source: "config" });
  });

  it("defaults to disable on Node 22", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
    expect(decision).toEqual({ value: false, source: "default-node22" });
  });

  it("returns null when no decision applies", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 20 });
    expect(decision).toEqual({ value: null });
  });
});
