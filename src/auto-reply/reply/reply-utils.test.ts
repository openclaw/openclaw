import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
import { matchesMentionWithExplicit } from "./mentions.js";
import { normalizeReplyPayload, normalizeReplyPayloadOutcome } from "./normalize-reply.js";
import { parseReplyDirectives } from "./reply-directives.js";
import { createReplyDispatcherWithTyping } from "./reply-dispatcher.js";
import { createReplyReferencePlanner } from "./reply-reference.js";
import {
  extractShortModelName,
  resolveResponsePrefixTemplate,
} from "./response-prefix-template.js";
import {
  createStreamingDirectiveAccumulator,
  splitTrailingDirective,
} from "./streaming-directives.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler, resolveTypingMode } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

function expectNormalizedReply(result: ReturnType<typeof normalizeReplyPayload>): ReplyPayload {
  if (result === null) {
    throw new Error("Expected normalized reply payload");
  }
  return result;
}

describe("matchesMentionWithExplicit", () => {
  it("combines explicit mentions with regex fallback", () => {
    for (const [text, isExplicitlyMentioned, expected] of [
      ["@openclaw hello", false, true],
      ["<@999999> hello", false, false],
      ["<@123456>", true, true],
    ] as const) {
      expect(
        matchesMentionWithExplicit({
          text,
          mentionRegexes: [/\bopenclaw\b/i],
          explicit: { hasAnyMention: true, isExplicitlyMentioned, canResolveExplicit: true },
        }),
        text,
      ).toBe(expected);
    }
  });

  it("lets catch-all regexes activate empty text without matching specific patterns", () => {
    expect(matchesMentionWithExplicit({ text: "", mentionRegexes: [/.*/i] })).toBe(true);
    expect(matchesMentionWithExplicit({ text: "", mentionRegexes: [/\bopenclaw\b/i] })).toBe(false);
  });
});

describe("normalizeReplyPayload", () => {
  it("preserves reply payload metadata across normalization clones", () => {
    const sourceReplyTranscriptMirror = {
      sessionKey: "main",
      text: " Visible reply ",
      idempotencyKey: "run-1:source-reply",
    };
    const payload = setReplyPayloadMetadata(
      { text: " Visible reply " },
      { sourceReplyTranscriptMirror },
    );
    const reply = expectNormalizedReply(normalizeReplyPayload(payload));
    expect(reply).not.toBe(payload);
    expect(getReplyPayloadMetadata(reply)?.sourceReplyTranscriptMirror).toEqual(
      sourceReplyTranscriptMirror,
    );
  });

  it("keeps channelData-only replies", () => {
    const channelData = { line: { flexMessage: { type: "bubble" } } };
    const reply = expectNormalizedReply(normalizeReplyPayload({ channelData }));
    expect(reply.text).toBeUndefined();
    expect(reply.channelData).toEqual(channelData);
  });

  it("records skip reasons for silent, empty, and internal artifact payloads", () => {
    for (const [text, reason] of [
      ['"NO_REPLY"', "silent"],
      [`${SILENT_REPLY_TOKEN}\n\n${SILENT_REPLY_TOKEN}`, "silent"],
      ["   ", "empty"],
      ["set-thought <channel|>", "silent"],
      ["───", "silent"],
    ] as const) {
      const onSkip = vi.fn();
      expect(normalizeReplyPayload({ text }, { onSkip }), text).toBeNull();
      expect(onSkip.mock.calls, text).toEqual([[reason]]);
    }
  });

  it("scopes transform ownership to the exact channel adapter and account", () => {
    const firstMessaging = {
      transformReplyPayload: vi.fn(({ payload }) => ({ ...payload, text: `${payload.text}!` })),
    } satisfies ChannelMessagingAdapter;
    const secondMessaging = {
      transformReplyPayload: vi.fn(() => null),
    } satisfies ChannelMessagingAdapter;
    const transform = (payload: ReplyPayload, accountId: string, messaging = firstMessaging) =>
      normalizeReplyPayloadOutcome(payload, {
        transformReplyPayload: createChannelReplyTransform({ messaging, cfg: {}, accountId }),
      });
    const first = transform({ text: "reply" }, "primary");
    if (first.kind !== "deliver") {
      throw new Error("Expected first channel transform to accept the payload");
    }
    expect(transform(first.payload, "primary")).toEqual({
      kind: "deliver",
      payload: { text: "reply!" },
    });
    const differentAccount = transform(first.payload, "secondary");
    expect(differentAccount).toEqual({ kind: "deliver", payload: { text: "reply!!" } });
    expect(
      normalizeReplyPayloadOutcome(first.payload, {
        transformReplyPayload: createChannelReplyTransform({
          messaging: secondMessaging,
          cfg: {},
          accountId: "primary",
        }),
      }),
    ).toEqual({ kind: "suppress", reason: "channel_transform" });
    if (differentAccount.kind !== "deliver") {
      throw new Error("Expected second account transform to accept the payload");
    }
    expect(transform(differentAccount.payload, "secondary")).toEqual({
      kind: "deliver",
      payload: { text: "reply!!" },
    });
    expect(transform(differentAccount.payload, "primary")).toEqual({
      kind: "deliver",
      payload: { text: "reply!!!" },
    });
    expect(firstMessaging.transformReplyPayload).toHaveBeenCalledTimes(3);
    expect(secondMessaging.transformReplyPayload).toHaveBeenCalledTimes(1);
  });

  it("strips NO_REPLY from mixed emoji message (#30916)", () => {
    expect(expectNormalizedReply(normalizeReplyPayload({ text: "😄 NO_REPLY" })).text).toBe("😄");
  });

  it("strips newline-separated leading silent tokens", () => {
    expect(
      expectNormalizedReply(
        normalizeReplyPayload({ text: "NO_REPLY NO_REPLY\nThe user is saying hello" }),
      ).text,
    ).toBe("The user is saying hello");
  });

  it("preserves repeated silent tokens before substantive punctuation", () => {
    const text = "NO_REPLY\nNO_REPLY: explanation";
    expect(expectNormalizedReply(normalizeReplyPayload({ text })).text).toBe(text);
  });

  it("suppresses leaked reasoning when the final answer is NO_REPLY (#66701)", () => {
    const onSkip = vi.fn();
    expect(
      normalizeReplyPayload(
        {
          text: "think\nCav is talking about a follow-up conversation.\nI will stay quiet here.NO_REPLY",
        },
        { onSkip },
      ),
    ).toBeNull();
    expect(onSkip.mock.calls).toEqual([["silent"]]);
  });

  it("suppresses tagged leaked reasoning ending in silence narration (#66701)", () => {
    const onSkip = vi.fn();
    expect(
      normalizeReplyPayload(
        {
          text: "<think>Cav is talking about a follow-up conversation.</think>\nI will stay quiet here.NO_REPLY",
        },
        { onSkip },
      ),
    ).toBeNull();
    expect(onSkip.mock.calls).toEqual([["silent"]]);
  });

  it("does not suppress JSON NO_REPLY objects with extra fields", () => {
    const text = '{"action":"NO_REPLY","note":"example"}';
    expect(expectNormalizedReply(normalizeReplyPayload({ text })).text).toBe(text);
  });

  it("strips JSON NO_REPLY action text but keeps media payload", () => {
    const reply = expectNormalizedReply(
      normalizeReplyPayload({
        text: '{"action":"NO_REPLY"}',
        mediaUrl: "https://example.com/img.png",
      }),
    );
    expect(reply.text).toBe("");
    expect(reply.mediaUrl).toBe("https://example.com/img.png");
  });
});

describe("typing controller", () => {
  afterEach(() => vi.useRealTimers());
  function createTestTypingController(keepalive = true) {
    const onReplyStart = vi.fn();
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
      keepalive,
    });
    return { typing, onReplyStart };
  }

  it("stops after run completion and dispatcher idle in either order, without restarting", async () => {
    vi.useFakeTimers();
    for (const runFirst of [true, false]) {
      const { typing, onReplyStart } = createTestTypingController();
      await typing.startTypingLoop();
      expect(onReplyStart).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onReplyStart).toHaveBeenCalledTimes(3);
      if (runFirst) {
        typing.markRunComplete();
      } else {
        typing.markDispatchIdle();
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onReplyStart).toHaveBeenCalledTimes(runFirst ? 3 : 5);
      if (runFirst) {
        typing.markDispatchIdle();
      } else {
        typing.markRunComplete();
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onReplyStart).toHaveBeenCalledTimes(runFirst ? 3 : 5);
      await typing.startTypingOnText("late tool result");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onReplyStart).toHaveBeenCalledTimes(runFirst ? 3 : 5);
    }
  });

  it("does not start typing after run completion", async () => {
    vi.useFakeTimers();
    const { typing, onReplyStart } = createTestTypingController();
    typing.markRunComplete();
    await typing.startTypingOnText("late text");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("keeps execution typing alive past its base TTL until the dispatcher settles", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => undefined);
    const onCleanup = vi.fn();
    const typing = createTypingController({ onReplyStart, onCleanup, typingIntervalSeconds: 121 });
    const lifecycle = createReplyDispatcherWithTyping({ deliver: async () => undefined });
    lifecycle.replyOptions.onTypingController?.(typing);
    const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: false });
    await signaler.signalExecutionActivity?.();
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(243_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);
    expect(onCleanup).not.toHaveBeenCalled();
    lifecycle.markRunComplete();
    lifecycle.dispatcher.markComplete();
    await lifecycle.dispatcher.waitForIdle();
    expect(onCleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(243_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);
  });

  it("sends the first typing signal without periodic keepalive refreshes", async () => {
    vi.useFakeTimers();
    const { typing, onReplyStart } = createTestTypingController(false);
    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    await typing.startTypingLoop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTypingMode", () => {
  it("resolves defaults, configured overrides, and heartbeat suppression", () => {
    const defaults = { isGroupChat: false, wasMentioned: false, isHeartbeat: false };
    const cases: Array<
      [Partial<Parameters<typeof resolveTypingMode>[0]>, ReturnType<typeof resolveTypingMode>]
    > = [
      [{}, "instant"],
      [{ isGroupChat: true }, "message"],
      [{ isGroupChat: true, sourceReplyDeliveryMode: "message_tool_only" }, "instant"],
      [
        { isGroupChat: true, sourceReplyDeliveryMode: "message_tool_only", configured: "message" },
        "message",
      ],
      [{ isGroupChat: true, wasMentioned: true }, "instant"],
      [{ configured: "instant", isHeartbeat: true }, "never"],
      [{ configured: "instant", suppressTyping: true }, "never"],
      [{ configured: "instant", typingPolicy: "system_event" }, "never"],
    ];
    for (const [input, expected] of cases) {
      expect(resolveTypingMode({ ...defaults, ...input })).toBe(expected);
    }
  });
});

describe("resolveResponsePrefixTemplate", () => {
  it("resolves known variables, aliases, and case-insensitive tokens", () => {
    expect(
      resolveResponsePrefixTemplate(
        "{MODEL} {modelFull} {provider} {thinkingLevel}/{think} {identity.name}/{identityName}",
        {
          model: "gpt-5.4",
          modelFull: "openai/gpt-5.4",
          provider: "openai",
          thinkingLevel: "high",
          identityName: "OpenClaw",
        },
      ),
    ).toBe("gpt-5.4 openai/gpt-5.4 openai high/high OpenClaw/OpenClaw");
  });

  it("preserves unresolved/unknown placeholders and handles static inputs", () => {
    expect(resolveResponsePrefixTemplate("{model}", {})).toBe("{model}");
    for (const [template, expected] of [
      [undefined, undefined],
      ["[Claude]", "[Claude]"],
      ["{model}/{provider}/{unknownVar}", "gpt-5.4/{provider}/{unknownVar}"],
    ] as const) {
      expect(resolveResponsePrefixTemplate(template, { model: "gpt-5.4" })).toBe(expected);
    }
  });
});

describe("createTypingSignaler", () => {
  it("gates run-start typing by mode", async () => {
    for (const mode of ["instant", "message", "thinking"] as const) {
      const typing = createMockTypingController();
      await createTypingSignaler({ typing, mode, isHeartbeat: false }).signalRunStart();
      expect(typing.startTypingLoop, mode).toHaveBeenCalledTimes(mode === "instant" ? 1 : 0);
    }
  });

  it("starts on reasoning delta and refreshes active typing on text", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({ typing, mode: "thinking", isHeartbeat: false });
    await signaler.signalReasoningDelta();
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    vi.mocked(typing.isActive).mockReturnValue(true);
    vi.mocked(typing.refreshTypingTtl).mockClear();
    await signaler.signalTextDelta("hi");
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("does not start typing for non-renderable deltas", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: false });
    for (const text of [undefined, "", " \t\n", SILENT_REPLY_TOKEN]) {
      await signaler.signalTextDelta(text);
      await signaler.signalMessageStart();
      await signaler.signalToolStart();
    }
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.refreshTypingTtl).not.toHaveBeenCalled();
  });

  it("suppresses tool-start typing in message mode until renderable text arrives", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: false });
    await signaler.signalToolStart();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.refreshTypingTtl).not.toHaveBeenCalled();
    await signaler.signalTextDelta("hello");
    expect(typing.startTypingOnText).toHaveBeenCalledExactlyOnceWith("hello");
    vi.mocked(typing.isActive).mockReturnValue(true);
    vi.mocked(typing.refreshTypingTtl).mockClear();
    await signaler.signalToolStart();
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("starts typing on tool-start for instant and thinking modes", async () => {
    for (const mode of ["instant", "thinking"] as const) {
      const typing = createMockTypingController();
      await createTypingSignaler({ typing, mode, isHeartbeat: false }).signalToolStart();
      expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
      expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    }
  });

  it("suppresses typing when disabled", async () => {
    for (const params of [
      { mode: "instant", isHeartbeat: true },
      { mode: "never", isHeartbeat: false },
    ] as const) {
      const typing = createMockTypingController();
      const signaler = createTypingSignaler({ typing, ...params });
      await signaler.signalRunStart();
      await signaler.signalTextDelta("hi");
      await signaler.signalReasoningDelta();
      await signaler.signalExecutionActivity?.();
      expect(typing.startTypingLoop).not.toHaveBeenCalled();
      expect(typing.startTypingOnText).not.toHaveBeenCalled();
    }
  });
});

describe("block reply coalescer", () => {
  afterEach(() => vi.useRealTimers());
  function createCoalescer(
    config: Partial<Parameters<typeof createBlockReplyCoalescer>[0]["config"]> = {},
  ) {
    const flushes: ReplyPayload[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " ", ...config },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload);
      },
    });
    return { flushes, coalescer };
  }

  it("waits until minChars before idle flush", async () => {
    vi.useFakeTimers();
    const { flushes, coalescer } = createCoalescer({ minChars: 10, idleMs: 50 });
    coalescer.enqueue({ text: "short" });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toStrictEqual([]);
    coalescer.enqueue({ text: "message" });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toEqual([{ text: "short message" }]);
    coalescer.stop();
  });

  it("does not coalesce reasoning blocks into visible reply text", async () => {
    const { flushes, coalescer } = createCoalescer({ joiner: "\n\n" });
    coalescer.enqueue({ text: "hidden", isReasoning: true });
    coalescer.enqueue({ text: "Visible answer" });
    await coalescer.flush({ force: true });
    expect(flushes).toEqual([{ text: "hidden", isReasoning: true }, { text: "Visible answer" }]);
    coalescer.stop();
  });

  it("preserves compaction and fallback notice markers across flushes", async () => {
    const { flushes, coalescer } = createCoalescer({ joiner: "\n\n" });
    coalescer.enqueue({ text: "Compacting context...", isCompactionNotice: true });
    coalescer.enqueue({ text: "Model Fallback: openai/gpt-5.5", isFallbackNotice: true });
    await coalescer.flush({ force: true });
    expect(flushes).toEqual([
      { text: "Compacting context...", isCompactionNotice: true },
      { text: "Model Fallback: openai/gpt-5.5", isFallbackNotice: true },
    ]);
    coalescer.stop();
  });

  it("flushes immediately per enqueue when flushOnEnqueue is set", async () => {
    const { flushes, coalescer } = createCoalescer({
      minChars: 10,
      idleMs: 50,
      flushOnEnqueue: true,
    });
    coalescer.enqueue({ text: "Hi" });
    coalescer.enqueue({ text: "Next" });
    await Promise.resolve();
    expect(flushes).toEqual([{ text: "Hi" }, { text: "Next" }]);
    coalescer.stop();
  });

  it("merges compatible buffered text into following media payloads", async () => {
    const { flushes, coalescer } = createCoalescer();
    coalescer.enqueue({ text: "Hello", replyToId: "thread-1" });
    coalescer.enqueue({ text: "world" });
    coalescer.enqueue({ mediaUrls: ["https://example.com/a.png"] });
    await coalescer.flush({ force: true });
    expect(flushes).toEqual([
      { text: "Hello world", mediaUrls: ["https://example.com/a.png"], replyToId: "thread-1" },
    ]);
    coalescer.stop();
  });

  it("keeps reasoning text separate from media payloads", async () => {
    const { flushes, coalescer } = createCoalescer();
    coalescer.enqueue({ text: "hidden", isReasoning: true });
    coalescer.enqueue({ mediaUrls: ["https://example.com/a.png"] });
    await coalescer.flush({ force: true });
    expect(flushes).toEqual([
      { text: "hidden", isReasoning: true },
      { mediaUrls: ["https://example.com/a.png"] },
    ]);
    coalescer.stop();
  });

  it("keeps buffered text separate when media changes reply target", async () => {
    const { flushes, coalescer } = createCoalescer();
    coalescer.enqueue({ text: "Unthreaded caption" });
    coalescer.enqueue({ mediaUrls: ["https://example.com/a.png"], replyToId: "thread-2" });
    await coalescer.flush({ force: true });
    expect(flushes).toEqual([
      { text: "Unthreaded caption" },
      { mediaUrls: ["https://example.com/a.png"], replyToId: "thread-2" },
    ]);
    coalescer.stop();
  });

  it("keeps text separate from voice media payloads", async () => {
    const { flushes, coalescer } = createCoalescer();
    coalescer.enqueue({ text: "Listen to this" });
    coalescer.enqueue({ mediaUrls: ["https://example.com/a.ogg"], audioAsVoice: true });
    await coalescer.flush({ force: true });
    expect(flushes).toEqual([
      { text: "Listen to this" },
      { mediaUrls: ["https://example.com/a.ogg"], audioAsVoice: true },
    ]);
    coalescer.stop();
  });
});

describe("createReplyReferencePlanner", () => {
  it("plans references for off/first/batched/all modes", () => {
    for (const replyToMode of ["off", "first", "batched", "all"] as const) {
      const planner = createReplyReferencePlanner({ replyToMode, startId: "parent" });
      expect(planner.peek()).toBe(replyToMode === "off" ? undefined : "parent");
      expect(planner.hasReplied()).toBe(false);
      expect(planner.use()).toBe(replyToMode === "off" ? undefined : "parent");
      expect(planner.hasReplied()).toBe(replyToMode !== "off");
      planner.markSent();
      expect(planner.peek()).toBe(replyToMode === "all" ? "parent" : undefined);
      expect(planner.use()).toBe(replyToMode === "all" ? "parent" : undefined);
    }
    const existing = createReplyReferencePlanner({
      replyToMode: "first",
      existingId: "thread-1",
      startId: "parent",
    });
    expect(existing.use()).toBe("thread-1");
    expect(existing.use()).toBeUndefined();
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
  it("handles reply tags split before the second bracket", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    expect(accumulator.consume("[")).toBeNull();
    expect(accumulator.consume("[reply_to_current]] Yo")).toMatchObject({
      text: "Yo",
      replyToCurrent: true,
    });
  });

  it("strips a malformed leading reply prefix split across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    expect(accumulator.consume("[[reply_to_")).toBeNull();
    expect(accumulator.consume("current] Visible reply")).toBeNull();
    expect(accumulator.consume("", { final: true })).toMatchObject({
      text: "Visible reply",
      replyToCurrent: false,
      replyToTag: false,
    });
  });

  it.each<[string, string[]]>([
    ["later line", ["Visible reply\n", "[[reply_to_", "current] literally"]],
    ["fenced code", ["```text\n[[reply_to_", "current]\n```"]],
  ])("preserves split malformed %s", (_name, chunks) => {
    const accumulator = createStreamingDirectiveAccumulator();
    const streamed = chunks.map((chunk) => accumulator.consume(chunk)?.text ?? "").join("");
    expect(streamed + (accumulator.consume("", { final: true })?.text ?? "")).toBe(chunks.join(""));
  });

  it("restores padding when a pending tail resolves as literal text beside a directive", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    const first = accumulator.consume("answer [[");
    const second = accumulator.consume("bogus]] [[reply_to_current]] tail");
    expect(`${first?.text ?? ""}${second?.text ?? ""}`).toBe("answer [[bogus]] tail");
  });

  it("propagates explicit reply ids until the assistant message resets", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    expect(accumulator.consume("[[reply_to: abc-123]]")).toBeNull();
    expect(accumulator.consume("Hi")).toMatchObject({
      text: "Hi",
      replyToId: "abc-123",
      replyToTag: true,
    });
    expect(accumulator.consume("test 2")).toMatchObject({ replyToId: "abc-123", replyToTag: true });
    expect(accumulator.consume("[[reply_to_current]][[reply_to: later]]")).toBeNull();
    expect(accumulator.consume("third")).toMatchObject({
      text: "third",
      replyToId: "later",
      replyToCurrent: true,
      replyToTag: true,
    });
    accumulator.reset();
    expect(accumulator.consume("second")).toMatchObject({
      replyToCurrent: false,
      replyToTag: false,
      replyToId: undefined,
    });
  });

  it("strips a glued leading NO_REPLY token from streamed text", () => {
    expect(
      createStreamingDirectiveAccumulator().consume("NO_REPLYThe user is saying hello")?.text,
    ).toBe("The user is saying hello");
  });

  it("keeps a split media prefix buffered until final parsing", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    expect(accumulator.consume("Preview:\n\tME")?.text).toBe("Preview:\n");
    expect(accumulator.consume("DIA:./asset.png")).toBeNull();
    expect(accumulator.consume("", { final: true })?.text).toBe("\tMEDIA:./asset.png");
  });

  it("strips audio voice tags from streamed chunks", () => {
    expect(
      createStreamingDirectiveAccumulator().consume("Hello\n[[audio_as_voice]]"),
    ).toMatchObject({ text: "Hello", audioAsVoice: true });
  });

  it("does not rewrite mid-prose MEDIA into a directive across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    const first = accumulator.consume("The legacy pipeline uses MEDIA");
    expect(first?.text).toBe("The legacy pipeline uses MEDIA");
    expect(first?.mediaUrls).toBeUndefined();
    const second = accumulator.consume(": kind=disk capacity=1TB");
    expect(second?.text).toBe(": kind=disk capacity=1TB");
    expect(second?.mediaUrls).toBeUndefined();
  });

  it("keeps a complete final MEDIA line available to the final parser", () => {
    expect(splitTrailingDirective("Here.\nMEDIA:/tmp/final.png")).toEqual({
      text: "Here.\n",
      tail: "MEDIA:/tmp/final.png",
    });
    expect(parseReplyDirectives("Here.\nMEDIA:/tmp/final.png")).toMatchObject({
      text: "Here.",
      mediaUrls: ["/tmp/final.png"],
    });
  });
});

describe("parseReplyDirectives malformed reply prefixes", () => {
  it.each([
    ["[[reply_to_current] Visible reply", "Visible reply"],
    ["[[reply_to:", ""],
  ])("strips %s without treating it as reply intent", (input, text) => {
    expect(parseReplyDirectives(input)).toMatchObject({
      text,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: false,
    });
  });
});

describe("extractShortModelName", () => {
  it("normalizes provider/date/latest suffixes while preserving other IDs", () => {
    for (const [input, expected] of [
      ["openai/gpt-5.4", "gpt-5.4"],
      ["claude-opus-4-6-20251101", "claude-opus-4-6"],
      ["gpt-5.4-latest", "gpt-5.4"],
      ["model-123456789", "model-123456789"],
    ] as const) {
      expect(extractShortModelName(input), input).toBe(expected);
    }
  });
});
