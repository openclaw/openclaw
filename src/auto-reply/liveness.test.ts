import { describe, expect, it } from "vitest";
import { buildLivenessResponse, checkLivenessTrigger } from "./liveness.js";

describe("checkLivenessTrigger", () => {
  it("matches case-insensitively", () => {
    expect(checkLivenessTrigger("/ALIVE", ["/alive"])).toBe(true);
  });

  it("matches trimmed body", () => {
    expect(checkLivenessTrigger("  /alive  ", ["/alive"])).toBe(true);
  });

  it("matches trigger as prefix with trailing content", () => {
    expect(checkLivenessTrigger("/alive extra content", ["/alive"])).toBe(true);
  });

  it("does not match partial word overlap", () => {
    expect(checkLivenessTrigger("/aliveness", ["/alive"])).toBe(false);
  });

  it("returns false when no trigger matches", () => {
    expect(checkLivenessTrigger("hello", ["/alive"])).toBe(false);
  });

  it("skips empty triggers", () => {
    expect(checkLivenessTrigger("/alive", ["", "/alive"])).toBe(true);
  });

  it("matches via mention-stripped body for group chats", () => {
    // In group chat, body might be "@Bot status" but mentionStripped is "status"
    expect(checkLivenessTrigger("@Bot status", ["status"], "status")).toBe(true);
  });

  it("does not match mention-stripped when trigger is absent", () => {
    expect(checkLivenessTrigger("@Bot hello", ["status"], "hello")).toBe(false);
  });
});

describe("buildLivenessResponse", () => {
  it("returns the expected status message", () => {
    expect(buildLivenessResponse()).toBe("✅ Online");
  });
});
