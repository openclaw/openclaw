// Tests agent runner helper decisions for payload and runtime preparation.
import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

const {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  isAudioPayload,
  signalTypingIfNeeded,
} = await import("./agent-runner-helpers.js");

describe("agent runner helpers", () => {
  it("detects audio payloads from mediaUrl/mediaUrls", () => {
    expect(isAudioPayload({ mediaUrl: "https://example.test/audio.mp3" })).toBe(true);
    expect(isAudioPayload({ mediaUrls: ["https://example.test/video.mp4"] })).toBe(false);
    expect(isAudioPayload({ mediaUrls: ["https://example.test/voice.m4a"] })).toBe(true);
  });

  it("uses fallback verbose level when session context is missing", () => {
    expect(createShouldEmitToolResult({ resolvedVerboseLevel: "off" })()).toBe(false);
    expect(createShouldEmitToolResult({ resolvedVerboseLevel: "on" })()).toBe(true);
    expect(createShouldEmitToolOutput({ resolvedVerboseLevel: "on" })()).toBe(false);
    expect(createShouldEmitToolOutput({ resolvedVerboseLevel: "full" })()).toBe(true);
  });

  it("uses the turn-owned preference while keeping explicit overrides fixed", () => {
    let level = "off";
    const params = { resolvedVerboseLevel: "on" as const, getVerboseLevel: () => level };
    const results = createShouldEmitToolResult(params);
    const output = createShouldEmitToolOutput(params);
    const explicit = createShouldEmitToolOutput({ ...params, verboseLevelOverride: "off" });
    expect(results()).toBe(false);
    expect(output()).toBe(false);
    level = "full";
    expect(results()).toBe(true);
    expect(output()).toBe(true);
    expect(explicit()).toBe(false);
    level = "invalid";
    expect(results()).toBe(true);
    expect(output()).toBe(false);
  });

  it("signals typing only when any payload has text or media", async () => {
    const signalRunStart = vi.fn().mockResolvedValue(undefined);
    const typingSignals = { signalRunStart } as unknown as TypingSignaler;
    const emptyPayloads: ReplyPayload[] = [{ text: "   " }, {}];
    await signalTypingIfNeeded(emptyPayloads, typingSignals);
    expect(signalRunStart).not.toHaveBeenCalled();

    await signalTypingIfNeeded([{ mediaUrl: "https://example.test/img.png" }], typingSignals);
    expect(signalRunStart).toHaveBeenCalledOnce();
  });
});
