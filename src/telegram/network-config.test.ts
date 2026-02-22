import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetTelegramNetworkConfigStateForTests,
  resolveTelegramAutoSelectFamilyDecision,
} from "./network-config.js";

// Mock isWSL2Sync at the top level
vi.mock("../infra/wsl.js", () => ({
  isWSL2Sync: vi.fn(() => false),
}));

import { isWSL2Sync } from "../infra/wsl.js";

describe("resolveTelegramAutoSelectFamilyDecision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTelegramNetworkConfigStateForTests();
  });

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

  it("defaults to enable on Node 22", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
    expect(decision).toEqual({ value: true, source: "default-node22" });
  });

  it("returns null when no decision applies", () => {
    const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 20 });
    expect(decision).toEqual({ value: null });
  });

  describe("WSL2 detection", () => {
    it("disables autoSelectFamily on WSL2", () => {
      vi.mocked(isWSL2Sync).mockReturnValue(true);
      const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
      expect(decision).toEqual({ value: false, source: "default-wsl2" });
    });

    it("respects config override on WSL2", () => {
      vi.mocked(isWSL2Sync).mockReturnValue(true);
      const decision = resolveTelegramAutoSelectFamilyDecision({
        env: {},
        network: { autoSelectFamily: true },
        nodeMajor: 22,
      });
      expect(decision).toEqual({ value: true, source: "config" });
    });

    it("respects env override on WSL2", () => {
      vi.mocked(isWSL2Sync).mockReturnValue(true);
      const decision = resolveTelegramAutoSelectFamilyDecision({
        env: { OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY: "1" },
        nodeMajor: 22,
      });
      expect(decision).toEqual({
        value: true,
        source: "env:OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY",
      });
    });

    it("uses Node 22 default when not on WSL2", () => {
      vi.mocked(isWSL2Sync).mockReturnValue(false);
      const decision = resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
      expect(decision).toEqual({ value: true, source: "default-node22" });
    });

    it("memoizes WSL2 detection across repeated defaults", () => {
      vi.mocked(isWSL2Sync).mockClear();
      vi.mocked(isWSL2Sync).mockReturnValue(false);
      resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
      resolveTelegramAutoSelectFamilyDecision({ env: {}, nodeMajor: 22 });
      expect(isWSL2Sync).toHaveBeenCalledTimes(1);
    });
  });
});
