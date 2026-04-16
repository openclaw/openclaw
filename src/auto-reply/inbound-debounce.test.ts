import { describe, expect, it } from "vitest";
import { resolveInboundDebounceMs } from "./inbound-debounce.js";
import type { OpenClawConfig } from "../config/types.js";

const cfg = (inbound: OpenClawConfig["messages"] = undefined): OpenClawConfig =>
  ({ messages: { inbound } } as unknown as OpenClawConfig);

describe("resolveInboundDebounceMs", () => {
  it("returns 0 when no config is set", () => {
    expect(resolveInboundDebounceMs({ cfg: cfg(), channel: "slack" })).toBe(0);
  });

  it("returns base debounceMs when set", () => {
    expect(
      resolveInboundDebounceMs({
        cfg: cfg({ debounceMs: 500 }),
        channel: "slack",
      }),
    ).toBe(500);
  });

  it("returns byChannel override over base debounceMs", () => {
    expect(
      resolveInboundDebounceMs({
        cfg: cfg({ debounceMs: 500, byChannel: { slack: 1000 } }),
        channel: "slack",
      }),
    ).toBe(1000);
  });

  it("returns explicit overrideMs over everything", () => {
    expect(
      resolveInboundDebounceMs({
        cfg: cfg({ debounceMs: 500, botDebounceMs: 9000, byChannel: { slack: 1000 } }),
        channel: "slack",
        overrideMs: 200,
        senderIsBot: true,
      }),
    ).toBe(200);
  });

  it("returns botDebounceMs when senderIsBot is true and no byChannel override", () => {
    expect(
      resolveInboundDebounceMs({
        cfg: cfg({ debounceMs: 500, botDebounceMs: 10000 }),
        channel: "slack",
        senderIsBot: true,
      }),
    ).toBe(10000);
  });

  it("does NOT apply botDebounceMs when senderIsBot is false", () => {
    expect(
      resolveInboundDebounceMs({
        cfg: cfg({ debounceMs: 500, botDebounceMs: 10000 }),
        channel: "slack",
        senderIsBot: false,
      }),
    ).toBe(500);
  });

  it("does NOT apply botDebounceMs when senderIsBot is omitted", () => {
    expect(
      resolveInboundDebounceMs({
        cfg: cfg({ debounceMs: 500, botDebounceMs: 10000 }),
        channel: "slack",
      }),
    ).toBe(500);
  });

  it("byChannel override wins over botDebounceMs", () => {
    expect(
      resolveInboundDebounceMs({
        cfg: cfg({ debounceMs: 500, botDebounceMs: 10000, byChannel: { slack: 2000 } }),
        channel: "slack",
        senderIsBot: true,
      }),
    ).toBe(2000);
  });

  it("falls back to base debounceMs when botDebounceMs is not set and senderIsBot is true", () => {
    expect(
      resolveInboundDebounceMs({
        cfg: cfg({ debounceMs: 500 }),
        channel: "slack",
        senderIsBot: true,
      }),
    ).toBe(500);
  });
});
