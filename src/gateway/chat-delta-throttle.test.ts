import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_DELTA_THROTTLE_MS,
  resolveChatDeltaThrottleMs,
} from "./chat-delta-throttle.js";

describe("resolveChatDeltaThrottleMs", () => {
  const originalEnv = process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS;
    } else {
      process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS = originalEnv;
    }
  });

  it("returns the default when env var is unset", () => {
    delete process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS;
    expect(resolveChatDeltaThrottleMs()).toBe(DEFAULT_CHAT_DELTA_THROTTLE_MS);
  });

  it("returns the default when env var is empty string", () => {
    process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS = "";
    expect(resolveChatDeltaThrottleMs()).toBe(DEFAULT_CHAT_DELTA_THROTTLE_MS);
  });

  it("honors a positive integer override", () => {
    process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS = "30";
    expect(resolveChatDeltaThrottleMs()).toBe(30);
  });

  it("honors zero (disables throttle)", () => {
    process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS = "0";
    expect(resolveChatDeltaThrottleMs()).toBe(0);
  });

  it("honors fractional values", () => {
    process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS = "75.5";
    expect(resolveChatDeltaThrottleMs()).toBe(75.5);
  });

  it("falls back to the default when the value is non-numeric", () => {
    process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS = "abc";
    expect(resolveChatDeltaThrottleMs()).toBe(DEFAULT_CHAT_DELTA_THROTTLE_MS);
  });

  it("falls back to the default when the value is NaN", () => {
    process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS = "NaN";
    expect(resolveChatDeltaThrottleMs()).toBe(DEFAULT_CHAT_DELTA_THROTTLE_MS);
  });

  it("falls back to the default when the value is negative", () => {
    process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS = "-50";
    expect(resolveChatDeltaThrottleMs()).toBe(DEFAULT_CHAT_DELTA_THROTTLE_MS);
  });
});
