import { describe, expect, it } from "vitest";
import { isNativeCommandSourceSessionKey } from "./native-command-source-session-key.js";

describe("isNativeCommandSourceSessionKey", () => {
  it.each([
    "agent:main:discord:slash:123456789012345678",
    "agent:other-agent:slack:slash:u123",
    "agent:main:slack:slash:team:t123:user:u123",
  ])("recognizes a bundled native command source: %s", (key) => {
    expect(isNativeCommandSourceSessionKey(key)).toBe(true);
  });

  it.each([
    "agent:main:discord:channel:slash",
    "agent:main:discord:slash:u123:thread:1",
    "agent:main:slack:slash:team:t123:channel:c123",
    "agent:main:slack:slash:team:t123:user:u123:extra",
    "agent:main:telegram:slash:u123",
    "agent:main:custom:discord:slash:u123",
    "agent:main:discord:slash:",
    "agent::discord:slash:u123",
  ])("does not classify a conversation or lookalike: %s", (key) => {
    expect(isNativeCommandSourceSessionKey(key)).toBe(false);
  });
});
