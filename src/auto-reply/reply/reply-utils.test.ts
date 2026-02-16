import { afterEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { parseAudioTag } from "./audio-tags.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
import { matchesMentionWithExplicit } from "./mentions.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { createReplyReferencePlanner } from "./reply-reference.js";
import {
  extractShortModelName,
  hasTemplateVariables,
  resolveResponsePrefixTemplate,
} from "./response-prefix-template.js";
import { createStreamingDirectiveAccumulator } from "./streaming-directives.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler, resolveTypingMode } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

describe("matchesMentionWithExplicit", () => {
  const mentionRegexes = [/\bopenclaw\b/i];

  it("checks mentionPatterns even when explicit mention is available", () => {
    const result = matchesMentionWithExplicit({
      text: "@openclaw hello",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(true);
  });

  it("returns false when explicit is false and no regex match", () => {
    const result = matchesMentionWithExplicit({
      text: "<@999999> hello",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(false);
  });

  it("returns true when explicitly mentioned even if regexes do not match", () => {
    const result = matchesMentionWithExplicit({
      text: "<@123456>",
      mentionRegexes: [],
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: true,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(true);
  });

  it("falls back to regex matching when explicit mention cannot be resolved", () => {
    const result = matchesMentionWithExplicit({
      text: "openclaw please",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: false,
      },
    });
    expect(result).toBe(true);
  });
});

// Keep channelData-only payloads so channel-specific replies survive normalization.
describe("normalizeReplyPayload", () => {
  it("keeps channelData-only replies", () => {
    const payload = {
      channelData: {
        line: {
          flexMessage: { type: "bubble" },
        },
      },
    };

    const normalized = normalizeReplyPayload(payload);

    expect(normalized).not.toBeNull();
    expect(normalized?.text).toBeUndefined();
    expect(normalized?.channelData).toEqual(payload.channelData);
  });

  it("records silent skips", () => {
    const reasons: string[] = [];
    const normalized = normalizeReplyPayload(
      { text: SILENT_REPLY_TOKEN },
      {
        onSkip: (reason) => reasons.push(reason),
      },
    );

    expect(normalized).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("records empty skips", () => {
    const reasons: string[] = [];
    const normalized = normalizeReplyPayload(
      { text: "   " },
      {
        onSkip: (reason) => reasons.push(reason),
      },
    );

    expect(normalized).toBeNull();
    expect(reasons).toEqual(["empty"]);
  });
});

describe("typing controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops after run completion and dispatcher idle", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);

    typing.markRunComplete();
    vi.advanceTimersByTime(1_000);
    expect(onReplyStart).toHaveBeenCalledTimes(4);

    typing.markDispatchIdle();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(4);
  });

  it("keeps typing until both idle and run completion are set", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    typing.markDispatchIdle();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);

    typing.markRunComplete();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);
  });

  it("does not start typing after run completion", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    typing.markRunComplete();
    await typing.startTypingOnText("late text");
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("does not restart typing after it has stopped", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    typing.markRunComplete();
    typing.markDispatchIdle();

    vi.advanceTimersByTime(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    // Late callbacks should be ignored and must not restart the interval.
    await typing.startTypingOnText("late tool result");
    vi.advanceTimersByTime(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTypingMode", () => {
  it("defaults to instant for direct chats", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("instant");
  });

  it("defaults to message for group chats without mentions", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: true,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("message");
  });

  it("defaults to instant for mentioned group chats", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: true,
        wasMentioned: true,
        isHeartbeat: false,
      }),
    ).toBe("instant");
  });

  it("honors configured mode across contexts", () => {
    expect(
      resolveTypingMode({
        configured: "thinking",
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("thinking");
    expect(
      resolveTypingMode({
        configured: "message",
        isGroupChat: true,
        wasMentioned: true,
        isHeartbeat: false,
      }),
    ).toBe("message");
  });

  it("forces never for heartbeat runs", () => {
    expect(
      resolveTypingMode({
        configured: "instant",
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: true,
      }),
    ).toBe("never");
  });
});

describe("createTypingSignaler", () => {
  it("signals immediately for instant mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "instant",
      isHeartbeat: false,
    });

    await signaler.signalRunStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("signals on text for message mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta("hello");

    expect(typing.startTypingOnText).toHaveBeenCalledWith("hello");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("signals on message start for message mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalMessageStart();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    await signaler.signalTextDelta("hello");
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hello");
  });

  it("signals on reasoning for thinking mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "thinking",
      isHeartbeat: false,
    });

    await signaler.signalReasoningDelta();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    await signaler.signalTextDelta("hi");
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("refreshes ttl on text for thinking mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "thinking",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta("hi");

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("starts typing on tool start before text", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalToolStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("refreshes ttl on tool start when active after text", async () => {
    const typing = createMockTypingController({
      isActive: vi.fn(() => true),
    });
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta("hello");
    typing.startTypingLoop.mockClear();
    typing.startTypingOnText.mockClear();
    typing.refreshTypingTtl.mockClear();
    await signaler.signalToolStart();

    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("suppresses typing when disabled", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "instant",
      isHeartbeat: true,
    });

    await signaler.signalRunStart();
    await signaler.signalTextDelta("hi");
    await signaler.signalReasoningDelta();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });
});

describe("parseAudioTag", () => {
  it("detects audio_as_voice and strips the tag", () => {
    const result = parseAudioTag("Hello [[audio_as_voice]] world");
    expect(result.audioAsVoice).toBe(true);
    expect(result.hadTag).toBe(true);
    expect(result.text).toBe("Hello world");
  });

  it("returns empty output for missing text", () => {
    const result = parseAudioTag(undefined);
    expect(result.audioAsVoice).toBe(false);
    expect(result.hadTag).toBe(false);
    expect(result.text).toBe("");
  });

  it("removes tag-only messages", () => {
    const result = parseAudioTag("[[audio_as_voice]]");
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe("");
  });
});

describe("block reply coalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces chunks within the idle window", async () => {
    vi.useFakeTimers();
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 100, joiner: " " },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });

    coalescer.enqueue({ text: "Hello" });
    coalescer.enqueue({ text: "world" });

    await vi.advanceTimersByTimeAsync(100);
    expect(flushes).toEqual(["Hello world"]);
    coalescer.stop();
  });

  it("waits until minChars before idle flush", async () => {
    vi.useFakeTimers();
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 200, idleMs: 50, joiner: " " },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });

    coalescer.enqueue({ text: "short" });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toEqual([]);

    coalescer.enqueue({ text: "message" });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toEqual(["short message"]);
    coalescer.stop();
  });

  it("flushes each enqueued payload separately when flushOnEnqueue is set", async () => {
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 100, joiner: "\n\n", flushOnEnqueue: true },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });

    coalescer.enqueue({ text: "First paragraph" });
    coalescer.enqueue({ text: "Second paragraph" });
    coalescer.enqueue({ text: "Third paragraph" });

    await Promise.resolve();
    expect(flushes).toEqual(["First paragraph", "Second paragraph", "Third paragraph"]);
    coalescer.stop();
  });

  it("still accumulates when flushOnEnqueue is not set (default)", async () => {
    vi.useFakeTimers();
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 2000, idleMs: 100, joiner: "\n\n" },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });

    coalescer.enqueue({ text: "First paragraph" });
    coalescer.enqueue({ text: "Second paragraph" });

    await vi.advanceTimersByTimeAsync(100);
    expect(flushes).toEqual(["First paragraph\n\nSecond paragraph"]);
    coalescer.stop();
  });

  it("flushes short payloads immediately when flushOnEnqueue is set", async () => {
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 200, idleMs: 50, joiner: "\n\n", flushOnEnqueue: true },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });

    coalescer.enqueue({ text: "Hi" });
    await Promise.resolve();
    expect(flushes).toEqual(["Hi"]);
    coalescer.stop();
  });

  it("resets char budget per paragraph with flushOnEnqueue", async () => {
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 30, idleMs: 100, joiner: "\n\n", flushOnEnqueue: true },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });

    // Each 20-char payload fits within maxChars=30 individually
    coalescer.enqueue({ text: "12345678901234567890" });
    coalescer.enqueue({ text: "abcdefghijklmnopqrst" });

    await Promise.resolve();
    // Without flushOnEnqueue, these would be joined to 40+ chars and trigger maxChars split.
    // With flushOnEnqueue, each is sent independently within budget.
    expect(flushes).toEqual(["12345678901234567890", "abcdefghijklmnopqrst"]);
    coalescer.stop();
  });

  it("flushes buffered text before media payloads", () => {
    const flushes: Array<{ text?: string; mediaUrls?: string[] }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " " },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push({
          text: payload.text,
          mediaUrls: payload.mediaUrls,
        });
      },
    });

    coalescer.enqueue({ text: "Hello" });
    coalescer.enqueue({ text: "world" });
    coalescer.enqueue({ mediaUrls: ["https://example.com/a.png"] });
    void coalescer.flush({ force: true });

    expect(flushes[0].text).toBe("Hello world");
    expect(flushes[1].mediaUrls).toEqual(["https://example.com/a.png"]);
    coalescer.stop();
  });
});

describe("createReplyReferencePlanner", () => {
  it("disables references when mode is off", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      startId: "parent",
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
  });

  it("uses startId once when mode is first", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "parent",
    });
    expect(planner.use()).toBe("parent");
    expect(planner.hasReplied()).toBe(true);
    planner.markSent();
    expect(planner.use()).toBeUndefined();
  });

  it("returns startId for every call when mode is all", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
    });
    expect(planner.use()).toBe("parent");
    expect(planner.use()).toBe("parent");
  });

  it("respects replyToMode off even with existingId", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      existingId: "thread-1",
      startId: "parent",
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
  });

  it("uses existingId once when mode is first", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      existingId: "thread-1",
      startId: "parent",
    });
    expect(planner.use()).toBe("thread-1");
    expect(planner.hasReplied()).toBe(true);
    expect(planner.use()).toBeUndefined();
  });

  it("uses existingId on every call when mode is all", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      existingId: "thread-1",
      startId: "parent",
    });
    expect(planner.use()).toBe("thread-1");
    expect(planner.use()).toBe("thread-1");
  });

  it("honors allowReference=false", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
      allowReference: false,
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
    planner.markSent();
    expect(planner.hasReplied()).toBe(true);
  });
});

describe("createStreamingDirectiveAccumulator", () => {
  it("stashes reply_to_current until a renderable chunk arrives", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to_current]]")).toBeNull();

    const result = accumulator.consume("Hello");
    expect(result?.text).toBe("Hello");
    expect(result?.replyToCurrent).toBe(true);
    expect(result?.replyToTag).toBe(true);
  });

  it("handles reply tags split across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    expect(accumulator.consume("[[reply_to_")).toBeNull();

    const result = accumulator.consume("current]] Yo");
    expect(result?.text).toBe("Yo");
    expect(result?.replyToCurrent).toBe(true);
    expect(result?.replyToTag).toBe(true);
  });

  it("propagates explicit reply ids across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to: abc-123]]")).toBeNull();

    const result = accumulator.consume("Hi");
    expect(result?.text).toBe("Hi");
    expect(result?.replyToId).toBe("abc-123");
    expect(result?.replyToTag).toBe(true);
  });
});

describe("resolveResponsePrefixTemplate", () => {
  it("returns undefined for undefined template", () => {
    expect(resolveResponsePrefixTemplate(undefined, {})).toBeUndefined();
  });

  it("returns template as-is when no variables present", () => {
    expect(resolveResponsePrefixTemplate("[Claude]", {})).toBe("[Claude]");
  });

  it("resolves {model} variable", () => {
    const result = resolveResponsePrefixTemplate("[{model}]", {
      model: "gpt-5.2",
    });
    expect(result).toBe("[gpt-5.2]");
  });

  it("resolves {modelFull} variable", () => {
    const result = resolveResponsePrefixTemplate("[{modelFull}]", {
      modelFull: "openai-codex/gpt-5.2",
    });
    expect(result).toBe("[openai-codex/gpt-5.2]");
  });

  it("resolves {provider} variable", () => {
    const result = resolveResponsePrefixTemplate("[{provider}]", {
      provider: "anthropic",
    });
    expect(result).toBe("[anthropic]");
  });

  it("resolves {thinkingLevel} variable", () => {
    const result = resolveResponsePrefixTemplate("think:{thinkingLevel}", {
      thinkingLevel: "high",
    });
    expect(result).toBe("think:high");
  });

  it("resolves {think} as alias for thinkingLevel", () => {
    const result = resolveResponsePrefixTemplate("think:{think}", {
      thinkingLevel: "low",
    });
    expect(result).toBe("think:low");
  });

  it("resolves {identity.name} variable", () => {
    const result = resolveResponsePrefixTemplate("[{identity.name}]", {
      identityName: "OpenClaw",
    });
    expect(result).toBe("[OpenClaw]");
  });

  it("resolves {identityName} as alias", () => {
    const result = resolveResponsePrefixTemplate("[{identityName}]", {
      identityName: "OpenClaw",
    });
    expect(result).toBe("[OpenClaw]");
  });

  it("resolves multiple variables", () => {
    const result = resolveResponsePrefixTemplate("[{model} | think:{thinkingLevel}]", {
      model: "claude-opus-4-5",
      thinkingLevel: "high",
    });
    expect(result).toBe("[claude-opus-4-5 | think:high]");
  });

  it("leaves unresolved variables as-is", () => {
    const result = resolveResponsePrefixTemplate("[{model}]", {});
    expect(result).toBe("[{model}]");
  });

  it("leaves unrecognized variables as-is", () => {
    const result = resolveResponsePrefixTemplate("[{unknownVar}]", {
      model: "gpt-5.2",
    });
    expect(result).toBe("[{unknownVar}]");
  });

  it("handles case insensitivity", () => {
    const result = resolveResponsePrefixTemplate("[{MODEL} | {ThinkingLevel}]", {
      model: "gpt-5.2",
      thinkingLevel: "low",
    });
    expect(result).toBe("[gpt-5.2 | low]");
  });

  it("handles mixed resolved and unresolved variables", () => {
    const result = resolveResponsePrefixTemplate("[{model} | {provider}]", {
      model: "gpt-5.2",
      // provider not provided
    });
    expect(result).toBe("[gpt-5.2 | {provider}]");
  });

  it("handles complex template with all variables", () => {
    const result = resolveResponsePrefixTemplate(
      "[{identity.name}] {provider}/{model} (think:{thinkingLevel})",
      {
        identityName: "OpenClaw",
        provider: "anthropic",
        model: "claude-opus-4-5",
        thinkingLevel: "high",
      },
    );
    expect(result).toBe("[OpenClaw] anthropic/claude-opus-4-5 (think:high)");
  });
});

describe("extractShortModelName", () => {
  it("strips provider prefix", () => {
    expect(extractShortModelName("openai/gpt-5.2")).toBe("gpt-5.2");
    expect(extractShortModelName("anthropic/claude-opus-4-5")).toBe("claude-opus-4-5");
    expect(extractShortModelName("openai-codex/gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("strips date suffix", () => {
    expect(extractShortModelName("claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
    expect(extractShortModelName("gpt-5.2-20250115")).toBe("gpt-5.2");
  });

  it("strips -latest suffix", () => {
    expect(extractShortModelName("gpt-5.2-latest")).toBe("gpt-5.2");
    expect(extractShortModelName("claude-sonnet-latest")).toBe("claude-sonnet");
  });

  it("preserves version numbers that look like dates but are not", () => {
    // Date suffix must be exactly 8 digits at the end
    expect(extractShortModelName("model-v1234567")).toBe("model-v1234567");
    expect(extractShortModelName("model-123456789")).toBe("model-123456789");
  });
});

describe("hasTemplateVariables", () => {
  it("returns false for empty string", () => {
    expect(hasTemplateVariables("")).toBe(false);
  });

  it("returns true when template variables present", () => {
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    expect(hasTemplateVariables("{provider}")).toBe(true);
    expect(hasTemplateVariables("prefix {thinkingLevel} suffix")).toBe(true);
  });

  it("handles consecutive calls correctly (regex lastIndex reset)", () => {
    // First call
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    // Second call should still work
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    // Static string should return false
    expect(hasTemplateVariables("[Claude]")).toBe(false);
  });
});
