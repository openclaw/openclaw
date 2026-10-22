import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { expect, it, vi } from "vitest";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { appendReplyMediaFailures, setReplyPayloadMetadata } from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

function createPresentation(
  options: {
    isHeartbeat?: boolean;
    silentExpected?: boolean;
    conversationContext?: string;
    onPartialReply?: GetReplyOptions["onPartialReply"];
    normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
    replyOperation?: AgentTurnParams["replyOperation"];
    typingSignals?: AgentTurnParams["typingSignals"];
    delivery?: Pick<
      AgentTurnParams,
      "opts" | "typingSignals" | "blockStreamingEnabled" | "blockReplyPipeline" | "applyReplyToMode"
    >;
  } = {},
) {
  const turn = {
    followupRun: { run: { silentExpected: options.silentExpected === true } },
    isHeartbeat: options.isHeartbeat === true,
    sessionCtx: { agentText: options.conversationContext },
    opts: { onPartialReply: options.onPartialReply },
    typingSignals:
      options.typingSignals ??
      createTypingSignaler({
        typing: createTypingController({}),
        mode: "never",
        isHeartbeat: options.isHeartbeat === true,
      }),
    replyOperation: options.replyOperation,
    ...options.delivery,
  } as unknown as AgentTurnParams;
  return createAgentTurnPresentation({
    turn,
    replyMediaContext: {
      normalizePayload: options.normalizeMediaPaths ?? (async (payload) => payload),
    },
    directBlockDeliveries: [],
  });
}

function createDeliveryPresentation(
  onPreparedBlockReply: NonNullable<GetReplyOptions["onPreparedBlockReply"]>,
  blockReplyPipeline: AgentTurnParams["blockReplyPipeline"] = null,
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>,
) {
  const typing = createTypingController({});
  const presentation = createPresentation({
    normalizeMediaPaths,
    delivery: {
      opts: { onPreparedBlockReply },
      blockStreamingEnabled: true,
      blockReplyPipeline,
      applyReplyToMode: (payload) => payload,
      typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
    },
  });
  const handler = presentation.blockReplyHandler;
  if (!handler) {
    throw new Error("expected the prepared block delivery handler");
  }
  return { handler, typing };
}

it("refreshes typing for whitespace appended while typing sends are failing", async () => {
  vi.useFakeTimers();
  const onCleanup = vi.fn();
  const onReplyStart = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new Error("temporary typing send failure"));
  const typing = createTypingController({ onReplyStart, onCleanup });
  const presentation = createPresentation({
    typingSignals: createTypingSignaler({ typing, mode: "message", isHeartbeat: false }),
  });
  try {
    await presentation.presentPartialReply({ text: "answer", delta: "answer" }, "embedded");
    await vi.advanceTimersByTimeAsync(119_000);
    await presentation.presentPartialReply({ text: "answer ", delta: " " }, "embedded");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(typing.isActive()).toBe(true);
    expect(onCleanup).not.toHaveBeenCalled();
  } finally {
    typing.cleanup();
    vi.useRealTimers();
  }
});

it("strips split heartbeat tokens and preserves replacement partials", async () => {
  const texts: Array<string | undefined> = [];
  const presentation = createPresentation({
    onPartialReply: (payload) => {
      texts.push(payload.text);
    },
  });
  for (const payload of [
    { text: "HEARTBEAT_", delta: "HEARTBEAT_" },
    { text: "HEARTBEAT_OK", delta: "OK" },
    { text: "HEARTBEAT_OK details", delta: " details" },
    { text: "replacement", delta: "", replace: true as const },
  ]) {
    await presentation.presentPartialReply(payload, "embedded");
  }
  expect(texts).toEqual(["HEARTBEAT_", "details", "replacement"]);
});

it.each([
  { name: "recorded silent caption", caption: "NO_REPLY", silent: true },
  { name: "JSON action caption", caption: '{"action":"NO_REPLY"}', silent: false },
  { name: "quoted token caption", caption: '"NO_REPLY"', silent: false },
  { name: "punctuated token caption", caption: "NO_REPLY.", silent: false },
  { name: "ordinary code-literal caption", caption: "Use `NO_REPLY` literally.", silent: false },
])("preserves $name policy across attachment normalization", async ({ caption, silent }) => {
  const retainedMedia = "https://example.invalid/retained.png";
  const delivered = vi.fn(async (_payload: ReplyPayload) => {});
  const { handler, typing } = createDeliveryPresentation(
    async (plan) => delivered(plan.payload),
    null,
    async (payload) => ({
      ...payload,
      text: appendReplyMediaFailures(payload.text, [
        { code: "delivery-failed", kind: "image", label: "Example" },
      ]),
      mediaUrl: retainedMedia,
      mediaUrls: [retainedMedia],
    }),
  );
  try {
    await handler(
      setReplyPayloadMetadata(
        {
          text: `[tool calls omitted]\n${caption}`,
          mediaUrls: ["https://example.invalid/failed.png", retainedMedia],
        },
        silent ? { silentReply: true } : {},
      ),
    );
    expect(delivered.mock.calls.map(([payload]) => payload.text)).toEqual([
      silent ? "" : `${caption}\n⚠️ Example: Delivery failed. Try sending this file again.`,
    ]);
    expect(
      delivered.mock.calls.map(([payload]) => resolveSendableOutboundReplyParts(payload).mediaUrls),
    ).toEqual([[retainedMedia]]);
  } finally {
    typing.cleanup();
  }
});

it.each([
  ["producer-authored silence", "NO_REPLY", true, "First.\n\nLast."],
  ["prepared literal suffix", "NO_REPLY", false, "First.\n\nNO_REPLY\n\nLast."],
  [
    "directive-stripped literal",
    "[tool calls omitted]\nNO_REPLY",
    false,
    "First.\n\nNO_REPLY\n\nLast.",
  ],
] as const)(
  "preserves %s policy through coalesced prepared delivery",
  async (_name, text, silent, expected) => {
    const delivered = vi.fn(async (_payload: ReplyPayload) => {});
    const dispatcher = createReplyDispatcher({
      deliver: delivered,
      deliverPrepared: async (plan) => delivered(plan.payload),
    });
    const forwardPrepared: NonNullable<
      NonNullable<AgentTurnParams["opts"]>["onPreparedBlockReply"]
    > = async (plan) => {
      dispatcher.sendPreparedReply("block", plan);
      await dispatcher.waitForIdle();
    };
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        for (const plan of createStructuredOutboundPayloadPlan([payload])) {
          await forwardPrepared(plan);
        }
      },
      timeoutMs: 0,
      coalescing: { minChars: 1, maxChars: 1200, idleMs: 0, joiner: "\n\n" },
    });
    const { handler, typing } = createDeliveryPresentation(forwardPrepared, pipeline);
    const middle = setReplyPayloadMetadata({ text }, silent ? { silentReply: true } : {});
    try {
      await handler({ text: "First." });
      await handler(middle);
      await handler({ text: "Last." });
      await pipeline.flush({ force: true });
      await dispatcher.waitForIdle();

      expect(delivered.mock.calls.map(([payload]) => payload.text)).toEqual([expected]);
    } finally {
      pipeline.stop();
      typing.cleanup();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
  },
);

it.each(["active", "committed", "completed"] as const)(
  "fences delayed typing when the reply operation is %s",
  async (ending) => {
    const replyOperation = createReplyOperation({
      sessionKey: `agent:main:typing-${ending}`,
      sessionId: `typing-${ending}`,
      resetTriggered: false,
    });
    replyOperation.setPhase("running");
    const typing = createDeferredCore();
    const onPresentation = vi.fn(() => true);
    const presentation = createPresentation({ replyOperation });
    const pending = presentation.presentWithTyping(typing.promise, onPresentation);
    try {
      expect(onPresentation).not.toHaveBeenCalled();
      if (ending === "committed") {
        replyOperation.freezeAbort();
      } else if (ending === "completed") {
        replyOperation.complete();
      }
      expect(replyOperation.abortSignal.aborted).toBe(false);
      typing.resolve();
      await pending;
      expect(onPresentation).toHaveBeenCalledTimes(ending === "active" ? 1 : 0);
    } finally {
      typing.resolve();
      await pending;
      replyOperation.complete();
    }
  },
);

const marker = "[Current message - respond to this]";
const currentContext = `${marker}\nprivate inbound paragraph`;
const historyContext = `[Chat messages since your last reply - for context]\nAlice: private history\n\n${currentContext}`;
const wrap = (text: string, prefix: string, continuation = prefix) =>
  text
    .split("\n")
    .map((line, index) => `${index === 0 ? prefix : continuation}${line}`)
    .join("\n");
const repeatedContext = `${marker}\nprivate first paragraph\n${marker}\nprivate final paragraph`;
const streamedAnswer = "Visible streamed answer.";
const xmlContext = historyContext.replace(
  "private inbound paragraph",
  '<function_calls><invoke name="exec">private XML</invoke></function_calls>\nprivate inbound paragraph',
);
type PromptCase = [
  name: string,
  copied: string,
  context?: string,
  answer?: string,
  skippedLengths?: number[],
];
const promptCases: PromptCase[] = [
  ...(
    [
      ["standard", "> "],
      ["indented", "  > "],
      ["nested", ">> "],
      ["spaced nested", "> > "],
      ["four-space code", "    "],
      ["tab-indented code", "\t"],
      ["bulleted list", "- "],
      ["numbered list", "1. "],
      ["heading", "# "],
      ["deep heading", "###### "],
      ["quoted heading", "> ## "],
      ["multiline list", "- ", "  "],
      ["wide list", "- ", "    "],
      ["varying quote depth", "> ", ">> "],
      ["quoted list", "> - ", ">   "],
      ["mixed code indentation", "    ", "\t"],
      ["unwrapped marker", "", "> "],
      ["very wide list", "- ", " ".repeat(320)],
      ["deep quote", "> ", `${">".repeat(320)} `],
    ] satisfies Array<[string, string, string?]>
  ).map(([name, prefix, continuation]): PromptCase => [
    name,
    wrap(historyContext, prefix, continuation),
    historyContext,
    streamedAnswer,
  ]),
  ...(
    [
      ["bulleted", "- ", "- ", "- "],
      ["quoted", "> ", "> ", "> "],
      ["indented", "    ", "    ", "    "],
      ["indented list", "- ", "    ", "    "],
      ["prompt-owned bullet", "- ", "    ", "- "],
      ["prompt-owned quote", "> ", ">> ", "> "],
    ] satisfies Array<[string, string, string, string]>
  ).map(([name, prefix, continuation, sourcePrefix]): PromptCase => {
    const context = `${marker}\n${sourcePrefix}private inbound paragraph`;
    return [name, wrap(context, prefix, continuation), context];
  }),
  ["same-line answer", wrap(currentContext, "Visible answer: ", "> ")],
  ["carriage returns", currentContext.replace(/\n/g, "\r"), currentContext, "Visible answer."],
  ["repeated source marker", wrap(repeatedContext, "- ", " ".repeat(320)), repeatedContext],
  [
    "unwrapped history",
    historyContext,
    historyContext,
    streamedAnswer,
    [1, 9, 50, 74, historyContext.length - 1],
  ],
  ...["private", "private inbound"].map((prefix): PromptCase => [
    `marker flood: ${prefix}`,
    `${marker}\n`.repeat(32) + prefix,
  ]),
  ["XML cleanup", xmlContext, xmlContext, streamedAnswer],
];
it.each(promptCases)(
  "withholds private prompt bytes: %s",
  (_name, copied, context, answer, skippedLengths) => {
    const presentation = createPresentation({ conversationContext: context ?? currentContext });
    for (let length = 1; length <= copied.length; length += 1) {
      const visibleText =
        presentation.normalizeStreamingText({ text: copied.slice(0, length) }).text ?? "";
      expect(visibleText).not.toContain("Alice");
      expect(visibleText).not.toContain("private");
    }
    for (const length of skippedLengths ?? []) {
      expect(presentation.normalizeStreamingText({ text: copied.slice(0, length) })).toEqual({
        skip: true,
      });
    }
    if (answer) {
      expect(presentation.normalizeStreamingText({ text: `${copied}\n\n${answer}` })).toEqual({
        text: answer,
        skip: false,
      });
    }
  },
);

it.each([
  ...["Safe introductory answer.\n", "Safe introductory answer: ", "```text\n"].map((prefix) => ({
    name: `safe prefix ${JSON.stringify(prefix)}`,
    text: prefix + currentContext.slice(0, 12),
    expected: prefix,
  })),
  {
    name: "newline-heavy answer",
    expected: undefined,
    text: Array.from({ length: 2_000 }, (_, index) => `Visible line ${index}`).join("\n"),
  },
  {
    name: "bracket-heavy answer",
    text: `${marker}${"[".repeat(40_000)}`,
    expected: `${marker}${"[".repeat(39_999)}`,
  },
])("preserves $name around prompt filtering", ({ text, expected }) => {
  const presentation = createPresentation({ conversationContext: currentContext });
  expect(presentation.normalizeStreamingText({ text })).toEqual({
    text: expected ?? text,
    skip: false,
  });
});

it("presents streaming control tokens without changing final text", async () => {
  const visible = (text: string) => ({ text, skip: false });
  const cases: Array<
    [ReplyPayload, { text?: string; skip: boolean }, Parameters<typeof createPresentation>[0]?]
  > = [
    ...[
      "visible answer",
      "H",
      "N",
      "NO_",
      "NO_REPLY",
      "NO_REPLY.",
      '"NO_REPLY"',
      '{"action":"NO_REPLY"}',
      "HEARTBEAT_",
      "NO_REPLYVisible",
      "NO_REPLYVisible answer",
      "NO_REPLY\nVisible answer",
      "No, that is wrong.",
    ].map((text): [ReplyPayload, { text: string; skip: boolean }] => [{ text }, visible(text)]),
    ...["HEARTBEAT_OK", " ", "  ", "  \n", "[tool calls omitted]"].map(
      (text): [ReplyPayload, { skip: boolean }] => [{ text }, { skip: true }],
    ),
    [{ text: "HEARTBEAT_OK visible after heartbeat" }, visible("visible after heartbeat")],
    [{ mediaUrls: ["https://example.invalid/image.png"] }, { text: undefined, skip: false }],
    [{ text: "visible" }, { skip: true }, { silentExpected: true }],
    [{ text: "HEARTBEAT_OK details" }, visible("HEARTBEAT_OK details"), { isHeartbeat: true }],
  ];
  for (const [payload, expected, options] of cases) {
    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>();
    const presentation = createPresentation({ ...options, onPartialReply });
    await presentation.presentPartialReply(payload, "cli");
    if (expected.skip || !expected.text) {
      expect(onPartialReply).not.toHaveBeenCalled();
    } else {
      expect(onPartialReply).toHaveBeenCalledExactlyOnceWith({ text: expected.text });
    }
    if (payload.mediaUrls) {
      expect(presentation.normalizeStreamingText(payload)).toEqual(expected);
    }
    if (payload.text === "N") {
      // Final text is not an incomplete cumulative preview (#122476).
      expect(presentation.normalizeStreamingText(payload)).toEqual({ text: "N", skip: false });
    }
  }
});

it("forwards prepared punctuation-prefixed text without control buffering", async () => {
  const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>();
  const presentation = createPresentation({ onPartialReply });

  for (const text of [".N", ". N", "- N", ".NO", ".NO_", ".NO_REPL", "*NO_", '"NO_', "（NO_"]) {
    await presentation.presentPartialReply({ text }, "cli");
  }
  expect(onPartialReply).toHaveBeenCalledTimes(9);
  for (const text of [
    ".NOTE: real content",
    "- Note: real content",
    ".No, that is wrong.",
    "💬NO_REPLY",
    "NO_REPLY👍",
    ".NO_REPLY: explanation",
    ".",
    "*",
  ]) {
    await presentation.presentPartialReply({ text }, "cli");
    expect(onPartialReply).toHaveBeenLastCalledWith({ text });
  }
  for (const text of [".NO", ".N", ". N", "- N", "*NO_", '"NO_', "（NO_", ".", "*"]) {
    expect(presentation.normalizeStreamingText({ text })).toEqual({ text, skip: false });
  }
});

it("keeps large ordinary previews visible after a punctuation prefix", async () => {
  const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>();
  const presentation = createPresentation({ onPartialReply });
  const text = `.NOTE: ${"ordinary text ".repeat(10_000)}`;

  await presentation.presentPartialReply({ text }, "cli");
  expect(onPartialReply).toHaveBeenCalledExactlyOnceWith({ text });
});
