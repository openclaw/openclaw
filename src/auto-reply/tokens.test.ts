import { describe, expect, it } from "vitest";
import { isSilentReplyPrefix, isSilentReplyText } from "./tokens.js";

describe("isSilentReplyPrefix", () => {
  it("matches prefixes of NO_REPLY", () => {
    expect(isSilentReplyPrefix("N")).toBe(true);
    expect(isSilentReplyPrefix("NO")).toBe(true);
    expect(isSilentReplyPrefix("NO_")).toBe(true);
    expect(isSilentReplyPrefix("NO_R")).toBe(true);
    expect(isSilentReplyPrefix("NO_RE")).toBe(true);
    expect(isSilentReplyPrefix("NO_REPL")).toBe(true);
    expect(isSilentReplyPrefix("NO_REPLY")).toBe(true);
  });

  it("matches prefixes of HEARTBEAT_OK when passed as token", () => {
    expect(isSilentReplyPrefix("H", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyPrefix("HEART", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyPrefix("HEARTBEAT", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyPrefix("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyPrefix("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isSilentReplyPrefix("  NO_R  ")).toBe(true);
    expect(isSilentReplyPrefix("\n")).toBe(false);
  });

  it("rejects non-prefixes", () => {
    expect(isSilentReplyPrefix("Hello")).toBe(false);
    expect(isSilentReplyPrefix("NO_REPLY and more")).toBe(false);
    expect(isSilentReplyPrefix("NOPE")).toBe(false);
    expect(isSilentReplyPrefix("X")).toBe(false);
  });

  it("returns false for empty/whitespace", () => {
    expect(isSilentReplyPrefix("")).toBe(false);
    expect(isSilentReplyPrefix("  ")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSilentReplyPrefix(undefined)).toBe(false);
  });
});

describe("isSilentReplyText", () => {
  it("matches exact NO_REPLY", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
    expect(isSilentReplyText("  NO_REPLY")).toBe(true);
  });

  it("rejects partial tokens", () => {
    expect(isSilentReplyText("NO_R")).toBe(false);
    expect(isSilentReplyText("NO_RE")).toBe(false);
  });
});
