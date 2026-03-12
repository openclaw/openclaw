import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  hasControlCommand,
  isControlCommandMessage,
  isOneShotThinkMessage,
} from "./command-detection.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

const cfgWithMiniAlias = {
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": { alias: "mini" },
      },
    },
  },
} satisfies OpenClawConfig;

describe("isOneShotThinkMessage", () => {
  it("detects /think <level> <body> as one-shot", () => {
    expect(isOneShotThinkMessage("/think high write me a poem")).toBe(true);
    expect(isOneShotThinkMessage("/think medium explain this")).toBe(true);
    expect(isOneShotThinkMessage("/think off just answer")).toBe(true);
    expect(isOneShotThinkMessage("/think xhigh deep analysis")).toBe(true);
    expect(isOneShotThinkMessage("/think adaptive solve this")).toBe(true);
  });

  it("detects aliases /thinking and /t (resolved by normalizeCommandBody)", () => {
    expect(isOneShotThinkMessage("/thinking high write me a poem")).toBe(true);
    expect(isOneShotThinkMessage("/t high write me a poem")).toBe(true);
  });

  it("preserves multiline bodies and punctuation after the level", () => {
    expect(isOneShotThinkMessage("/think high\nwrite me a poem")).toBe(true);
    expect(isOneShotThinkMessage("/think high, write me a poem")).toBe(true);
  });

  it("supports bot-targeted think commands only for the addressed bot", () => {
    expect(
      isOneShotThinkMessage("/think@openclaw high write me a poem", {
        botUsername: "openclaw",
      }),
    ).toBe(true);
    expect(
      isOneShotThinkMessage("/think@otherbot high write me a poem", {
        botUsername: "openclaw",
      }),
    ).toBe(false);
  });

  it("rejects bare /think <level> without body", () => {
    expect(isOneShotThinkMessage("/think high")).toBe(false);
    expect(isOneShotThinkMessage("/think medium")).toBe(false);
    expect(isOneShotThinkMessage("/think off")).toBe(false);
  });

  it("rejects /think <level> followed by only whitespace (no actual body)", () => {
    expect(isOneShotThinkMessage("/think high   ")).toBe(false);
    expect(isOneShotThinkMessage("/think medium  \t ")).toBe(false);
  });

  it("rejects /think with invalid level", () => {
    expect(isOneShotThinkMessage("/think banana write me a poem")).toBe(false);
    expect(isOneShotThinkMessage("/think 123 write me a poem")).toBe(false);
  });

  it("rejects directive-only tails after the think level", () => {
    expect(isOneShotThinkMessage("/think high /status")).toBe(false);
    expect(isOneShotThinkMessage("/think high /exec host=sandbox")).toBe(false);
    expect(isOneShotThinkMessage("/think high /queue interrupt")).toBe(false);
  });

  it("rejects non-think commands", () => {
    expect(isOneShotThinkMessage("/status")).toBe(false);
    expect(isOneShotThinkMessage("/help")).toBe(false);
    expect(isOneShotThinkMessage("plain text")).toBe(false);
  });

  it("rejects mid-text /think (not leading command)", () => {
    expect(isOneShotThinkMessage("compare /think high vs /think low")).toBe(false);
    expect(isOneShotThinkMessage("hey /think high tell me")).toBe(false);
  });

  it("handles level aliases (ultra, max, etc.)", () => {
    expect(isOneShotThinkMessage("/think ultra write me a poem")).toBe(true);
    expect(isOneShotThinkMessage("/think max write me a poem")).toBe(true);
  });
});

describe("hasControlCommand with one-shot think", () => {
  it("returns false for /think <level> <body> (one-shot)", () => {
    expect(hasControlCommand("/think high write me a poem")).toBe(false);
    expect(hasControlCommand("/t medium explain this")).toBe(false);
    expect(hasControlCommand("/think high\nwrite me a poem")).toBe(false);
    expect(hasControlCommand("/think high, write me a poem")).toBe(false);
  });

  it("returns true for bare /think <level>", () => {
    expect(hasControlCommand("/think high")).toBe(true);
    expect(hasControlCommand("/think medium")).toBe(true);
  });

  it("returns true for /think <level> followed by directive-only tails", () => {
    expect(hasControlCommand("/think high /status")).toBe(true);
    expect(hasControlCommand("/think high /exec host=sandbox")).toBe(true);
    expect(hasControlCommand("/think high /queue interrupt")).toBe(true);
  });

  it("treats model alias tails as directive-only when config defines the alias", () => {
    expect(hasControlCommand("/think high /mini", cfgWithMiniAlias)).toBe(true);
  });

  it("preserves bot-targeted one-shot detection when config omits agents", () => {
    const cfgWithoutAgents = {} satisfies OpenClawConfig;

    expect(
      hasControlCommand("/think@openclaw high write me a poem", cfgWithoutAgents, {
        botUsername: "openclaw",
      }),
    ).toBe(false);
  });
});

describe("isControlCommandMessage with one-shot think", () => {
  it("treats /think <level> as control command", () => {
    expect(isControlCommandMessage("/think high")).toBe(true);
    expect(isControlCommandMessage("/think medium")).toBe(true);
  });

  it("does NOT treat /think <level> <body> as control command", () => {
    expect(isControlCommandMessage("/think high write me a poem")).toBe(false);
    expect(isControlCommandMessage("/think medium explain this concept")).toBe(false);
  });

  it("does NOT treat /think <level> <body> via aliases as control command", () => {
    expect(isControlCommandMessage("/t high write me a poem")).toBe(false);
    expect(isControlCommandMessage("/thinking medium explain this")).toBe(false);
  });

  it("still treats other commands with args as control commands", () => {
    expect(isControlCommandMessage("/send on")).toBe(true);
  });
});
