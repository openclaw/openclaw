import { describe, expect, it } from "vitest";
import { stripEnvelope } from "./message-extract";

describe("stripEnvelope", () => {
  it("strips UTC envelope", () => {
    const text = "[WebChat agent:main:main 2026-01-18T05:19Z] hello world";
    expect(stripEnvelope(text)).toBe("hello world");
  });

  it("strips local-time envelope", () => {
    const text = "[Telegram Ada Lovelace (@ada) id:1234 2026-01-18 19:29 GMT+1] test";
    expect(stripEnvelope(text)).toBe("test");
  });

  it("strips envelopes without timestamps for known channels", () => {
    const text = "[WhatsApp +1234567890] hi there";
    expect(stripEnvelope(text)).toBe("hi there");
  });

  it("handles multi-line messages", () => {
    const text = "[Slack #general 2026-01-18T05:19Z] first line\nsecond line";
    expect(stripEnvelope(text)).toBe("first line\nsecond line");
  });

  it("returns text as-is when no envelope present", () => {
    const text = "just a regular message";
    expect(stripEnvelope(text)).toBe("just a regular message");
  });

  it("does not strip non-envelope brackets", () => {
    expect(stripEnvelope("[OK] hello")).toBe("[OK] hello");
    expect(stripEnvelope("[1/2] step one")).toBe("[1/2] step one");
  });
});
