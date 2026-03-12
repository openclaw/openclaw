import { describe, expect, it } from "vitest";
import { isControlCommandMessage, isOneShotThinkMessage } from "./command-detection.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

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

  it("rejects non-think commands", () => {
    expect(isOneShotThinkMessage("/status")).toBe(false);
    expect(isOneShotThinkMessage("/help")).toBe(false);
    expect(isOneShotThinkMessage("plain text")).toBe(false);
  });

  it("handles level aliases (ultra, max, etc.)", () => {
    expect(isOneShotThinkMessage("/think ultra write me a poem")).toBe(true);
    expect(isOneShotThinkMessage("/think max write me a poem")).toBe(true);
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
