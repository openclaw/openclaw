import { describe, expect, it } from "vitest";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";

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

describe("resolveTelegramDnsResultOrderDecision", () => {
  it("uses env override when provided", () => {
    const decision = resolveTelegramDnsResultOrderDecision({
      env: { OPENCLAW_TELEGRAM_DNS_RESULT_ORDER: "verbatim" },
      nodeMajor: 22,
    });
    expect(decision).toEqual({
      value: "verbatim",
      source: "env:OPENCLAW_TELEGRAM_DNS_RESULT_ORDER",
    });
  });

  it("uses config override when provided", () => {
    const decision = resolveTelegramDnsResultOrderDecision({
      network: { dnsResultOrder: "ipv4first" },
      nodeMajor: 20,
    });
    expect(decision).toEqual({ value: "ipv4first", source: "config" });
  });

  it("defaults to ipv4first on Node 22", () => {
    const decision = resolveTelegramDnsResultOrderDecision({ nodeMajor: 22 });
    expect(decision).toEqual({ value: "ipv4first", source: "default-node22" });
  });

  it("returns null when no dns decision applies", () => {
    const decision = resolveTelegramDnsResultOrderDecision({ nodeMajor: 20 });
    expect(decision).toEqual({ value: null });
  });
});
