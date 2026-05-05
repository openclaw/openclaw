import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

const hoisted = vi.hoisted(() => {
  const loadSessionStoreMock = vi.fn();
  return { loadSessionStoreMock };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    loadSessionStore: (...args: unknown[]) => hoisted.loadSessionStoreMock(...args),
  };
});

const {
  classifyToolRunActivity,
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  isAudioPayload,
  readToolNameFromReplyPayload,
  shouldSignalTypingForRunActivity,
  signalTypingIfNeeded,
} = await import("./agent-runner-helpers.js");

describe("agent runner helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
    hoisted.loadSessionStoreMock.mockReset();
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

  it("caches session verbose reads briefly while still refreshing live changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { verboseLevel: "full" },
    });
    const shouldEmitOutput = createShouldEmitToolOutput({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "off",
    });

    expect(shouldEmitOutput()).toBe(true);
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { verboseLevel: "off" },
    });
    expect(shouldEmitOutput()).toBe(true);
    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledOnce();

    vi.setSystemTime(1_251);
    expect(shouldEmitOutput()).toBe(false);
    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledTimes(2);
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

  it("classifies internal tool activity", () => {
    expect(classifyToolRunActivity({ toolName: "exec" })).toBe("background-internal");
    expect(classifyToolRunActivity({ toolName: "process" })).toBe("background-internal");
    expect(classifyToolRunActivity({ toolName: "sessions_spawn" })).toBe("subagent-internal");
    expect(classifyToolRunActivity({ toolName: "sessions_yield" })).toBe("yield-wait");
    expect(classifyToolRunActivity({ toolName: "read" })).toBe("visible-tool");
  });

  it("suppresses Telegram typing for internal tool activity only", () => {
    expect(
      shouldSignalTypingForRunActivity({ kind: "background-internal", channel: "telegram" }),
    ).toBe(false);
    expect(
      shouldSignalTypingForRunActivity({
        kind: "tool-result",
        toolName: "exec",
        channel: "telegram",
      }),
    ).toBe(false);
    expect(
      shouldSignalTypingForRunActivity({
        kind: "tool-result",
        toolName: "read",
        channel: "telegram",
      }),
    ).toBe(true);
    expect(
      shouldSignalTypingForRunActivity({ kind: "background-internal", channel: "whatsapp" }),
    ).toBe(true);
  });

  it("reads tool names from direct and channel payload metadata", () => {
    expect(readToolNameFromReplyPayload({ text: "x", channelData: { toolName: "exec" } })).toBe(
      "exec",
    );
    expect(readToolNameFromReplyPayload({ text: "x", toolName: "process" } as ReplyPayload)).toBe(
      "process",
    );
  });

  it("signals typing only when any payload has text or media", async () => {
    const signalRunStart = vi.fn().mockResolvedValue(undefined);
    const typingSignals = { signalRunStart } as unknown as TypingSignaler;
    const emptyPayloads: ReplyPayload[] = [{ text: "   " }, {}];
    await signalTypingIfNeeded(emptyPayloads, typingSignals);
    expect(signalRunStart).not.toHaveBeenCalled();

    await signalTypingIfNeeded([{ mediaUrl: "https://example.test/img.png" }], typingSignals);
    expect(signalRunStart).toHaveBeenCalledOnce();

    await signalTypingIfNeeded([{ text: "internal" }], typingSignals, {
      kind: "background-internal",
      channel: "telegram",
    });
    expect(signalRunStart).toHaveBeenCalledOnce();
  });
});
