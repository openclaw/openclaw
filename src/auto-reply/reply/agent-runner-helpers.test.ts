import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

const hoisted = vi.hoisted(() => {
  const loadSessionStoreMock = vi.fn();
  const scheduleFollowupDrainMock = vi.fn();
  return { loadSessionStoreMock, scheduleFollowupDrainMock };
});

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: (...args: unknown[]) => hoisted.loadSessionStoreMock(...args),
  };
});

vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return {
    ...actual,
    scheduleFollowupDrain: (...args: unknown[]) => hoisted.scheduleFollowupDrainMock(...args),
  };
});

const {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  finalizeWithFollowup,
  isAudioPayload,
  signalTypingIfNeeded,
} = await import("./agent-runner-helpers.js");

describe("agent runner helpers", () => {
  beforeEach(() => {
    hoisted.loadSessionStoreMock.mockClear();
    hoisted.scheduleFollowupDrainMock.mockClear();
  });

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

  it("uses session verbose level when present", () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { verboseLevel: "full" },
    });
    const shouldEmitResult = createShouldEmitToolResult({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "off",
    });
    const shouldEmitOutput = createShouldEmitToolOutput({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "off",
    });
    expect(shouldEmitResult()).toBe(true);
    expect(shouldEmitOutput()).toBe(true);
  });

  it("falls back when store read fails or session value is invalid", () => {
    hoisted.loadSessionStoreMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const fallbackOn = createShouldEmitToolResult({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "on",
    });
    expect(fallbackOn()).toBe(true);

    hoisted.loadSessionStoreMock.mockClear();
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { verboseLevel: "weird" },
    });
    const fallbackFull = createShouldEmitToolOutput({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "full",
    });
    expect(fallbackFull()).toBe(true);
  });

  it("schedules followup drain and returns the original value", () => {
    const runFollowupTurn = vi.fn();
    const value = { ok: true };
    expect(finalizeWithFollowup(value, "queue-key", runFollowupTurn)).toBe(value);
    expect(hoisted.scheduleFollowupDrainMock).toHaveBeenCalledWith("queue-key", runFollowupTurn);
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
