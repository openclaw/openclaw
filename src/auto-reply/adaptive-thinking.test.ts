import { describe, expect, it } from "vitest";
import { mapThinkingLevel } from "../agents/pi-embedded-runner/utils.js";
import { normalizeThinkLevel } from "./thinking.js";

/**
 * Tests for OpenClaw's adaptive thinking pipeline: user input flows through
 * normalizeThinkLevel → mapThinkingLevel → pi-agent-core session creation.
 *
 * These tests exercise the real OpenClaw functions that determine what
 * thinking level reaches the provider layer (where pi-ai applies adaptive
 * thinking for Opus 4.6+).
 */
describe("mapThinkingLevel", () => {
  it("passes through each canonical level unchanged", () => {
    expect(mapThinkingLevel("off")).toBe("off");
    expect(mapThinkingLevel("minimal")).toBe("minimal");
    expect(mapThinkingLevel("low")).toBe("low");
    expect(mapThinkingLevel("medium")).toBe("medium");
    expect(mapThinkingLevel("high")).toBe("high");
    expect(mapThinkingLevel("xhigh")).toBe("xhigh");
  });

  it("defaults to off when no level is provided", () => {
    expect(mapThinkingLevel(undefined)).toBe("off");
  });
});

describe("thinking level normalization for adaptive thinking", () => {
  it("maps max/highest aliases to high (effort: high on Opus 4.6)", () => {
    expect(mapThinkingLevel(normalizeThinkLevel("max"))).toBe("high");
    expect(mapThinkingLevel(normalizeThinkLevel("highest"))).toBe("high");
    expect(mapThinkingLevel(normalizeThinkLevel("ultra"))).toBe("high");
  });

  it("preserves xhigh through the pipeline (effort: max on Opus 4.6)", () => {
    expect(mapThinkingLevel(normalizeThinkLevel("xhigh"))).toBe("xhigh");
    expect(mapThinkingLevel(normalizeThinkLevel("x-high"))).toBe("xhigh");
    expect(mapThinkingLevel(normalizeThinkLevel("extra-high"))).toBe("xhigh");
  });

  it("maps on/enable aliases to low", () => {
    expect(mapThinkingLevel(normalizeThinkLevel("on"))).toBe("low");
    expect(mapThinkingLevel(normalizeThinkLevel("enable"))).toBe("low");
  });

  it("defaults to off for unrecognized input", () => {
    expect(mapThinkingLevel(normalizeThinkLevel("nonsense"))).toBe("off");
    expect(mapThinkingLevel(normalizeThinkLevel(""))).toBe("off");
    expect(mapThinkingLevel(normalizeThinkLevel(null))).toBe("off");
  });
});
