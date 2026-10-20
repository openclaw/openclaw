import { afterEach, assert, expect, it, vi } from "vitest";
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";
import type { TypingMode } from "../../config/types.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";
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

it.each([
  ["@openclaw hello", /\bopenclaw\b/i, false, true],
  ["<@999999> hello", /\bopenclaw\b/i, false, false],
  ["<@123456>", /\bopenclaw\b/i, true, true],
  ["", /.*/i, undefined, true],
  ["", /\bopenclaw\b/i, undefined, false],
] as const)("resolves mention %s with %s (explicit=%s)", (text, regex, explicit, expected) => {
  expect(
    matchesMentionWithExplicit({
      text,
      mentionRegexes: [regex],
      explicit:
        explicit === undefined
          ? undefined
          : {
              hasAnyMention: true,
              isExplicitlyMentioned: explicit,
              canResolveExplicit: true,
            },
    }),
  ).toBe(expected);
});
it("keeps channelData-only replies", () => {
  const channelData = { line: { flexMessage: { type: "bubble" } } };
  expect(normalizeReplyPayload({ channelData })).toEqual({ channelData });
});

it("records skip reasons for silent, empty, and internal artifact payloads", () => {
  for (const [text, reason] of [
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
  const transform = (
    payload: ReplyPayload,
    accountId: string,
    messaging: ChannelMessagingAdapter = firstMessaging,
  ) =>
    normalizeReplyPayloadOutcome(payload, {
      transformReplyPayload: createChannelReplyTransform({ messaging, cfg: {}, accountId }),
    });
  const delivered = (payload: ReplyPayload, accountId: string, text: string) => {
    const outcome = transform(payload, accountId);
    expect(outcome).toEqual({ kind: "deliver", payload: { text } });
    assert(outcome.kind === "deliver");
    return outcome.payload;
  };
  const first = delivered({ text: "reply" }, "primary", "reply!");
  delivered(first, "primary", "reply!");
  const differentAccount = delivered(first, "secondary", "reply!!");
  expect(transform(first, "primary", secondMessaging)).toEqual({
    kind: "suppress",
    reason: "channel_transform",
  });
  delivered(differentAccount, "secondary", "reply!!");
  delivered(differentAccount, "primary", "reply!!!");
  expect(firstMessaging.transformReplyPayload).toHaveBeenCalledTimes(3);
  expect(secondMessaging.transformReplyPayload).toHaveBeenCalledTimes(1);
});

it.each([
  "😄 NO_REPLY",
  "NO_REPLY NO_REPLY\nThe user is saying hello",
  "NO_REPLYThe user is saying hello",
  "An answer followed by NO_REPLY",
])("preserves non-control token mentions: %s", (text) => {
  expect(normalizeReplyPayload({ text })).toMatchObject({ text });
});

afterEach(() => vi.useRealTimers());
function createTestTypingController(options: Parameters<typeof createTypingController>[0] = {}) {
  vi.useFakeTimers();
  const onReplyStart = options.onReplyStart ?? vi.fn();
  const typing = createTypingController({
    onReplyStart,
    typingIntervalSeconds: 1,
    keepalive: true,
    ...options,
  });
  const advance = async (ms: number, calls: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    expect(onReplyStart).toHaveBeenCalledTimes(calls);
  };
  return { typing, onReplyStart, advance };
}

it.each([true, false])("stops without restarting (run completes first: %s)", async (runFirst) => {
  const { typing, onReplyStart, advance } = createTestTypingController();
  await typing.startTypingLoop();
  expect(onReplyStart).toHaveBeenCalledTimes(1);
  await advance(2_000, 3);
  const first = runFirst ? typing.markRunComplete : typing.markDispatchIdle;
  const last = runFirst ? typing.markDispatchIdle : typing.markRunComplete;
  first();
  await advance(2_000, runFirst ? 3 : 5);
  last();
  await advance(2_000, runFirst ? 3 : 5);
  await typing.startTypingOnText("late tool result");
  await advance(5_000, runFirst ? 3 : 5);
});

it("does not start typing after run completion", async () => {
  const { typing, onReplyStart } = createTestTypingController();
  typing.markRunComplete();
  await typing.startTypingOnText("late text");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(onReplyStart).not.toHaveBeenCalled();
});

it("keeps execution typing alive past its base TTL until the dispatcher settles", async () => {
  const onCleanup = vi.fn();
  const { typing, onReplyStart, advance } = createTestTypingController({
    onReplyStart: vi.fn(async () => undefined),
    onCleanup,
    typingIntervalSeconds: 121,
  });
  const lifecycle = createReplyDispatcherWithTyping({ deliver: async () => undefined });
  lifecycle.replyOptions.onTypingController?.(typing);
  const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: false });
  await signaler.signalExecutionActivity?.();
  expect(onReplyStart).toHaveBeenCalledTimes(1);
  await advance(243_000, 3);
  expect(onCleanup).not.toHaveBeenCalled();
  lifecycle.markRunComplete();
  lifecycle.dispatcher.markComplete();
  await lifecycle.dispatcher.waitForIdle();
  expect(onCleanup).toHaveBeenCalledTimes(1);
  await advance(243_000, 3);
});

it("sends the first typing signal without periodic keepalive refreshes", async () => {
  const { typing, onReplyStart, advance } = createTestTypingController({ keepalive: false });
  await typing.startTypingLoop();
  expect(onReplyStart).toHaveBeenCalledTimes(1);
  await advance(5_000, 1);
  await typing.startTypingLoop();
  await advance(5_000, 1);
});

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

it.each([
  ["{model}", {}, "{model}"],
  [undefined, { model: "gpt-5.4" }, undefined],
  ["[Claude]", { model: "gpt-5.4" }, "[Claude]"],
  ["{model}/{provider}/{unknownVar}", { model: "gpt-5.4" }, "gpt-5.4/{provider}/{unknownVar}"],
])("resolves prefix %s", (template, context, expected) => {
  expect(resolveResponsePrefixTemplate(template, context)).toBe(expected);
});

function createTestSignaler(mode: TypingMode = "message", isHeartbeat = false) {
  const typing = createMockTypingController();
  return { typing, signaler: createTypingSignaler({ typing, mode, isHeartbeat }) };
}
type MockTyping = ReturnType<typeof createMockTypingController>;
function expectTypingCalls(typing: MockTyping, loop: number, refresh: number, text = 0) {
  expect([
    vi.mocked(typing.startTypingLoop).mock.calls.length,
    vi.mocked(typing.refreshTypingTtl).mock.calls.length,
    vi.mocked(typing.startTypingOnText).mock.calls.length,
  ]).toEqual([loop, refresh, text]);
}
it("gates run-start typing by mode", async () => {
  for (const mode of ["instant", "message", "thinking"] as const) {
    const { typing, signaler } = createTestSignaler(mode);
    await signaler.signalRunStart();
    expect(typing.startTypingLoop, mode).toHaveBeenCalledTimes(mode === "instant" ? 1 : 0);
  }
});

it("starts on reasoning delta and refreshes active typing on text", async () => {
  const { typing, signaler } = createTestSignaler("thinking");
  await signaler.signalReasoningDelta();
  expectTypingCalls(typing, 1, 1);
  vi.mocked(typing.isActive).mockReturnValue(true);
  vi.mocked(typing.refreshTypingTtl).mockClear();
  await signaler.signalTextDelta("hi");
  expectTypingCalls(typing, 1, 1);
});

it("does not start typing for non-renderable deltas", async () => {
  const { typing, signaler } = createTestSignaler();
  for (const text of [undefined, "", " \t\n"]) {
    await signaler.signalTextDelta(text);
    await signaler.signalMessageStart();
    await signaler.signalToolStart();
  }
  expectTypingCalls(typing, 0, 0);
});

it("suppresses tool-start typing in message mode until renderable text arrives", async () => {
  const { typing, signaler } = createTestSignaler();
  await signaler.signalToolStart();
  expectTypingCalls(typing, 0, 0);
  await signaler.signalTextDelta("hello");
  expect(typing.startTypingOnText).toHaveBeenCalledExactlyOnceWith("hello");
  vi.mocked(typing.isActive).mockReturnValue(true);
  vi.mocked(typing.refreshTypingTtl).mockClear();
  await signaler.signalToolStart();
  expectTypingCalls(typing, 0, 1, 1);
});

it("suppresses typing when disabled", async () => {
  for (const params of [
    { mode: "instant", isHeartbeat: true },
    { mode: "never", isHeartbeat: false },
  ] as const) {
    const { typing, signaler } = createTestSignaler(params.mode, params.isHeartbeat);
    await signaler.signalRunStart();
    await signaler.signalTextDelta("hi");
    await signaler.signalReasoningDelta();
    await signaler.signalExecutionActivity?.();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  }
});

function createCoalescer(config: Partial<BlockStreamingCoalescing> = {}) {
  const flushes: ReplyPayload[] = [];
  const coalescer = createBlockReplyPipeline({
    timeoutMs: 0,
    coalescing: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " ", ...config },
    onBlockReply: (payload) => {
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

const mediaUrls = ["https://example.com/a.png"];
type FlushCase = [string, ReplyPayload[], ReplyPayload[]?, Partial<BlockStreamingCoalescing>?];
it.each<FlushCase>([
  [
    "preserves notice markers",
    [
      { text: "Compacting context...", isCompactionNotice: true },
      { text: "Model Fallback: openai/gpt-5.5", isFallbackNotice: true },
    ],
    undefined,
    { joiner: "\n\n" },
  ],
  [
    "merges text with compatible media",
    [{ text: "Hello", replyToId: "thread-1" }, { text: "world" }, { mediaUrls }],
    [{ text: "Hello world", mediaUrls, replyToId: "thread-1" }],
  ],
  [
    "separates changed reply targets",
    [{ text: "Unthreaded caption" }, { mediaUrls, replyToId: "thread-2" }],
  ],
])("%s", async (_name, payloads, expected, config) => {
  const { flushes, coalescer } = createCoalescer(config);
  payloads.forEach((payload) => coalescer.enqueue(structuredClone(payload)));
  await coalescer.flush({ force: true });
  expect(flushes).toEqual(expected ?? payloads);
  coalescer.stop();
});

it("plans references for off/first/batched/all modes", () => {
  for (const replyToMode of ["off", "first", "batched", "all"] as const) {
    const planner = createReplyReferencePlanner({ replyToMode, startId: "parent" });
    const initial = replyToMode === "off" ? undefined : "parent";
    expect([planner.peek(), planner.hasReplied(), planner.use(), planner.hasReplied()]).toEqual([
      initial,
      false,
      initial,
      replyToMode !== "off",
    ]);
    planner.markSent();
    const next = replyToMode === "all" ? "parent" : undefined;
    expect([planner.peek(), planner.use()]).toEqual([next, next]);
  }
  const existing = createReplyReferencePlanner({
    replyToMode: "first",
    existingId: "thread-1",
    startId: "parent",
  });
  expect([existing.use(), existing.use()]).toEqual(["thread-1", undefined]);
});

type StreamResult = ReturnType<ReturnType<typeof createStreamingDirectiveAccumulator>["consume"]>;
type StreamCase = [string, string[], Array<Partial<StreamResult>>, boolean?];
it.each<StreamCase>([
  ...["NO_REPLY", "no_reply", "No_Reply"].map((token): StreamCase => [
    `chunked ${token}`,
    [token.slice(0, 4), token.slice(4), "\nVisible reply"],
    [null, null, { text: "Visible reply" }],
  ]),
  [
    "split reply tag",
    ["[", "[reply_to_current]] Yo"],
    [null, { text: "Yo", replyToCurrent: true }],
  ],
  [
    "malformed leading reply prefix",
    ["[[reply_to_", "current] Visible reply", ""],
    [null, null, { text: "Visible reply", replyToCurrent: false, replyToTag: false }],
    true,
  ],
])("parses %s", (_name, chunks, expected, final = false) => {
  const accumulator = createStreamingDirectiveAccumulator();
  expect(
    chunks.map((chunk, i) =>
      accumulator.consume(chunk, { final: final && i === chunks.length - 1 }),
    ),
  ).toMatchObject(expected);
});

it("preserves split malformed fenced code", () => {
  const chunks = ["```text\n[[reply_to_", "current]\n```"];
  const accumulator = createStreamingDirectiveAccumulator();
  const streamed = chunks.map((chunk) => accumulator.consume(chunk)?.text ?? "").join("");
  expect(streamed + (accumulator.consume("", { final: true })?.text ?? "")).toBe(chunks.join(""));
});

it("propagates explicit reply ids until the assistant message resets", () => {
  const accumulator = createStreamingDirectiveAccumulator();
  expect(accumulator.consume("[[reply_to: a]]")).toBeNull();
  expect(accumulator.consume("Hi")).toMatchObject({ text: "Hi", replyToId: "a", replyToTag: true });
  expect(accumulator.consume("test 2")).toMatchObject({ replyToId: "a", replyToTag: true });
  expect(accumulator.consume("[[reply_to_current]][[reply_to: b]]")).toBeNull();
  expect(accumulator.consume("3")).toMatchObject({
    text: "3",
    replyToId: "b",
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

it("preserves a glued leading NO_REPLY mention in streamed text", () => {
  const text = "NO_REPLYThe user is saying hello";
  expect(createStreamingDirectiveAccumulator().consume(text)?.text).toBe(text);
});

it("keeps a complete final MEDIA line available to the final parser", () => {
  const input = "Here.\nMEDIA:/tmp/a.png";
  expect(splitTrailingDirective(input)).toEqual({ text: "Here.\n", tail: "MEDIA:/tmp/a.png" });
  expect(parseReplyDirectives(input)).toMatchObject({ text: "Here.", mediaUrls: ["/tmp/a.png"] });
});
it("strips an incomplete reply tag without treating it as reply intent", () => {
  expect(parseReplyDirectives("[[reply_to:")).toMatchObject({
    text: "",
    replyToId: undefined,
    replyToCurrent: undefined,
    replyToTag: false,
  });
});

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
