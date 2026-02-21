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

  it("combines explicit-mention state with regex fallback rules", () => {
    const cases = [
      {
        name: "regex match with explicit resolver available",
        text: "@openclaw hello",
        mentionRegexes,
        explicit: {
          hasAnyMention: true,
          isExplicitlyMentioned: false,
          canResolveExplicit: true,
        },
        expected: true,
      },
      {
        name: "no explicit and no regex match",
        text: "<@999999> hello",
        mentionRegexes,
        explicit: {
          hasAnyMention: true,
          isExplicitlyMentioned: false,
          canResolveExplicit: true,
        },
        expected: false,
      },
      {
        name: "explicit mention even without regex",
        text: "<@123456>",
        mentionRegexes: [],
        explicit: {
          hasAnyMention: true,
          isExplicitlyMentioned: true,
          canResolveExplicit: true,
        },
        expected: true,
      },
      {
        name: "falls back to regex when explicit cannot resolve",
        text: "openclaw please",
        mentionRegexes,
        explicit: {
          hasAnyMention: true,
          isExplicitlyMentioned: false,
          canResolveExplicit: false,
        },
        expected: true,
      },
    ] as const;
    for (const testCase of cases) {
      const result = matchesMentionWithExplicit({
        text: testCase.text,
        mentionRegexes: [...testCase.mentionRegexes],
        explicit: testCase.explicit,
      });
      expect(result, testCase.name).toBe(testCase.expected);
    }
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

  it("records skip reasons for silent/empty payloads", () => {
    const cases = [
      { name: "silent", payload: { text: SILENT_REPLY_TOKEN }, reason: "silent" },
      { name: "empty", payload: { text: "   " }, reason: "empty" },
    ] as const;
    for (const testCase of cases) {
      const reasons: string[] = [];
      const normalized = normalizeReplyPayload(testCase.payload, {
        onSkip: (reason) => reasons.push(reason),
      });
      expect(normalized, testCase.name).toBeNull();
      expect(reasons, testCase.name).toEqual([testCase.reason]);
    }
  });
});

describe("typing controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops only after both run completion and dispatcher idle are set (any order)", async () => {
    vi.useFakeTimers();
    const cases = [
      { name: "run-complete first", first: "run", second: "idle" },
      { name: "dispatch-idle first", first: "idle", second: "run" },
    ] as const;

    for (const testCase of cases) {
      const onReplyStart = vi.fn(async () => {});
      const typing = createTypingController({
        onReplyStart,
        typingIntervalSeconds: 1,
        typingTtlMs: 30_000,
      });

      await typing.startTypingLoop();
      expect(onReplyStart, testCase.name).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      expect(onReplyStart, testCase.name).toHaveBeenCalledTimes(3);

      if (testCase.first === "run") {
        typing.markRunComplete();
      } else {
        typing.markDispatchIdle();
      }
      vi.advanceTimersByTime(2_000);
      expect(onReplyStart, testCase.name).toHaveBeenCalledTimes(5);

      if (testCase.second === "run") {
        typing.markRunComplete();
      } else {
        typing.markDispatchIdle();
      }
      vi.advanceTimersByTime(2_000);
      expect(onReplyStart, testCase.name).toHaveBeenCalledTimes(5);
    }
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
  it("resolves defaults, configured overrides, and heartbeat suppression", () => {
    const cases = [
      {
        name: "default direct chat",
        input: {
          configured: undefined,
          isGroupChat: false,
          wasMentioned: false,
          isHeartbeat: false,
        },
        expected: "instant",
      },
      {
        name: "default group chat without mention",
        input: {
          configured: undefined,
          isGroupChat: true,
          wasMentioned: false,
          isHeartbeat: false,
        },
        expected: "message",
      },
      {
        name: "default mentioned group chat",
        input: {
          configured: undefined,
          isGroupChat: true,
          wasMentioned: true,
          isHeartbeat: false,
        },
        expected: "instant",
      },
      {
        name: "configured thinking override",
        input: {
          configured: "thinking" as const,
          isGroupChat: false,
          wasMentioned: false,
          isHeartbeat: false,
        },
        expected: "thinking",
      },
      {
        name: "configured message override",
        input: {
          configured: "message" as const,
          isGroupChat: true,
          wasMentioned: true,
          isHeartbeat: false,
        },
        expected: "message",
      },
      {
        name: "heartbeat forces never",
        input: {
          configured: "instant" as const,
          isGroupChat: false,
          wasMentioned: false,
          isHeartbeat: true,
        },
        expected: "never",
      },
    ] as const;

    for (const testCase of cases) {
      expect(resolveTypingMode(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("parseAudioTag", () => {
  it("extracts audio tag state and cleaned text", () => {
    const cases = [
      {
        name: "tag in sentence",
        input: "Hello [[audio_as_voice]] world",
        expected: { audioAsVoice: true, hadTag: true, text: "Hello world" },
      },
      {
        name: "missing text",
        input: undefined,
        expected: { audioAsVoice: false, hadTag: false, text: "" },
      },
      {
        name: "tag-only content",
        input: "[[audio_as_voice]]",
        expected: { audioAsVoice: true, hadTag: true, text: "" },
      },
    ] as const;
    for (const testCase of cases) {
      const result = parseAudioTag(testCase.input);
      expect(result.audioAsVoice, testCase.name).toBe(testCase.expected.audioAsVoice);
      expect(result.hadTag, testCase.name).toBe(testCase.expected.hadTag);
      expect(result.text, testCase.name).toBe(testCase.expected.text);
    }
  });
});

describe("resolveResponsePrefixTemplate", () => {
  it("resolves known variables, aliases, and case-insensitive tokens", () => {
    const cases = [
      {
        name: "model",
        template: "[{model}]",
        values: { model: "gpt-5.2" },
        expected: "[gpt-5.2]",
      },
      {
        name: "modelFull",
        template: "[{modelFull}]",
        values: { modelFull: "openai-codex/gpt-5.2" },
        expected: "[openai-codex/gpt-5.2]",
      },
      {
        name: "provider",
        template: "[{provider}]",
        values: { provider: "anthropic" },
        expected: "[anthropic]",
      },
      {
        name: "thinkingLevel",
        template: "think:{thinkingLevel}",
        values: { thinkingLevel: "high" },
        expected: "think:high",
      },
      {
        name: "think alias",
        template: "think:{think}",
        values: { thinkingLevel: "low" },
        expected: "think:low",
      },
      {
        name: "identity.name",
        template: "[{identity.name}]",
        values: { identityName: "OpenClaw" },
        expected: "[OpenClaw]",
      },
      {
        name: "identityName alias",
        template: "[{identityName}]",
        values: { identityName: "OpenClaw" },
        expected: "[OpenClaw]",
      },
      {
        name: "case-insensitive variables",
        template: "[{MODEL} | {ThinkingLevel}]",
        values: { model: "gpt-5.2", thinkingLevel: "low" },
        expected: "[gpt-5.2 | low]",
      },
      {
        name: "all variables",
        template: "[{identity.name}] {provider}/{model} (think:{thinkingLevel})",
        values: {
          identityName: "OpenClaw",
          provider: "anthropic",
          model: "claude-opus-4-5",
          thinkingLevel: "high",
        },
        expected: "[OpenClaw] anthropic/claude-opus-4-5 (think:high)",
      },
    ] as const;
    for (const testCase of cases) {
      expect(resolveResponsePrefixTemplate(testCase.template, testCase.values), testCase.name).toBe(
        testCase.expected,
      );
    }
  });

  it("preserves unresolved/unknown placeholders and handles static inputs", () => {
    const cases = [
      { name: "undefined template", template: undefined, values: {}, expected: undefined },
      { name: "no variables", template: "[Claude]", values: {}, expected: "[Claude]" },
      {
        name: "unresolved known variable",
        template: "[{model}]",
        values: {},
        expected: "[{model}]",
      },
      {
        name: "unrecognized variable",
        template: "[{unknownVar}]",
        values: { model: "gpt-5.2" },
        expected: "[{unknownVar}]",
      },
      {
        name: "mixed resolved/unresolved",
        template: "[{model} | {provider}]",
        values: { model: "gpt-5.2" },
        expected: "[gpt-5.2 | {provider}]",
      },
    ] as const;
    for (const testCase of cases) {
      expect(resolveResponsePrefixTemplate(testCase.template, testCase.values), testCase.name).toBe(
        testCase.expected,
      );
    }
  });
});

describe("createTypingSignaler", () => {
  it("gates run-start typing by mode", async () => {
    const cases = [
      { name: "instant", mode: "instant" as const, expectedStartCalls: 1 },
      { name: "message", mode: "message" as const, expectedStartCalls: 0 },
      { name: "thinking", mode: "thinking" as const, expectedStartCalls: 0 },
    ] as const;
    for (const testCase of cases) {
      const typing = createMockTypingController();
      const signaler = createTypingSignaler({
        typing,
        mode: testCase.mode,
        isHeartbeat: false,
      });

      await signaler.signalRunStart();
      expect(typing.startTypingLoop, testCase.name).toHaveBeenCalledTimes(
        testCase.expectedStartCalls,
      );
    }
  });

  it("signals on message-mode boundaries and text deltas", async () => {
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
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("starts typing and refreshes ttl on text for thinking mode", async () => {
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
    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("handles tool-start typing before and after active text mode", async () => {
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
    (typing.isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (typing.startTypingLoop as ReturnType<typeof vi.fn>).mockClear();
    (typing.refreshTypingTtl as ReturnType<typeof vi.fn>).mockClear();
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

  it("flushes immediately per enqueue when flushOnEnqueue is set", async () => {
    const cases = [
      {
        config: { minChars: 10, maxChars: 200, idleMs: 50, joiner: "\n\n", flushOnEnqueue: true },
        inputs: ["Hi"],
        expected: ["Hi"],
      },
      {
        config: { minChars: 1, maxChars: 30, idleMs: 100, joiner: "\n\n", flushOnEnqueue: true },
        inputs: ["12345678901234567890", "abcdefghijklmnopqrst"],
        expected: ["12345678901234567890", "abcdefghijklmnopqrst"],
      },
    ] as const;

    for (const testCase of cases) {
      const flushes: string[] = [];
      const coalescer = createBlockReplyCoalescer({
        config: testCase.config,
        shouldAbort: () => false,
        onFlush: (payload) => {
          flushes.push(payload.text ?? "");
        },
      });
      for (const input of testCase.inputs) {
        coalescer.enqueue({ text: input });
      }
      await Promise.resolve();
      expect(flushes).toEqual(testCase.expected);
      coalescer.stop();
    }
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
  it("plans references correctly for off/first/all modes", () => {
    const offPlanner = createReplyReferencePlanner({
      replyToMode: "off",
      startId: "parent",
    });
    expect(offPlanner.use()).toBeUndefined();

    const firstPlanner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "parent",
    });
    expect(firstPlanner.use()).toBe("parent");
    expect(firstPlanner.hasReplied()).toBe(true);
    firstPlanner.markSent();
    expect(firstPlanner.use()).toBeUndefined();

    const allPlanner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
    });
    expect(allPlanner.use()).toBe("parent");
    expect(allPlanner.use()).toBe("parent");

    const existingIdPlanner = createReplyReferencePlanner({
      replyToMode: "first",
      existingId: "thread-1",
      startId: "parent",
    });
    expect(existingIdPlanner.use()).toBe("thread-1");
    expect(existingIdPlanner.use()).toBeUndefined();
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
  });

  it("propagates explicit reply ids across current and subsequent chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to: abc-123]]")).toBeNull();

    const first = accumulator.consume("Hi");
    expect(first?.text).toBe("Hi");
    expect(first?.replyToId).toBe("abc-123");
    expect(first?.replyToTag).toBe(true);

    const second = accumulator.consume("test 2");
    expect(second?.replyToId).toBe("abc-123");
    expect(second?.replyToTag).toBe(true);
  });

  it("clears sticky reply context on reset", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to_current]]")).toBeNull();
    expect(accumulator.consume("first")?.replyToCurrent).toBe(true);

    accumulator.reset();

    const afterReset = accumulator.consume("second");
    expect(afterReset?.replyToCurrent).toBe(false);
    expect(afterReset?.replyToTag).toBe(false);
    expect(afterReset?.replyToId).toBeUndefined();
  });
});

describe("extractShortModelName", () => {
  it("normalizes provider/date/latest suffixes while preserving other IDs", () => {
    const cases = [
      ["openai-codex/gpt-5.2-codex", "gpt-5.2-codex"],
      ["claude-opus-4-5-20251101", "claude-opus-4-5"],
      ["gpt-5.2-latest", "gpt-5.2"],
      // Date suffix must be exactly 8 digits at the end.
      ["model-123456789", "model-123456789"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(extractShortModelName(input), input).toBe(expected);
    }
  });
});

describe("hasTemplateVariables", () => {
  it("handles empty, static, and repeated variable checks", () => {
    expect(hasTemplateVariables("")).toBe(false);
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    expect(hasTemplateVariables("[Claude]")).toBe(false);
  });
});
