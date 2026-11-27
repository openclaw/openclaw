import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { DirectBlockDelivery } from "./reply-delivery.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

function createPresentation(
  options: {
    silentExpected?: boolean;
    directBlockDeliveries?: DirectBlockDelivery[];
    conversationContext?: string;
    onPartialReply?: GetReplyOptions["onPartialReply"];
    replyOperation?: AgentTurnParams["replyOperation"];
    typingSignals?: AgentTurnParams["typingSignals"];
    onBlockReply?: GetReplyOptions["onBlockReply"];
    onPreparedBlockReply?: GetReplyOptions["onPreparedBlockReply"];
    pipeline?: AgentTurnParams["blockReplyPipeline"];
  } = {},
) {
  const typing = createTypingController({});
  const turn = {
    followupRun: { run: { silentExpected: options.silentExpected === true } },
    sessionCtx: { agentText: options.conversationContext },
    opts: {
      onPartialReply: options.onPartialReply,
      onBlockReply: options.onBlockReply,
      onPreparedBlockReply: options.onPreparedBlockReply,
    },
    typingSignals:
      options.typingSignals ??
      createTypingSignaler({
        typing,
        mode: "never",
      }),
    replyOperation: options.replyOperation,
    blockStreamingEnabled: true,
    blockReplyPipeline: options.pipeline ?? null,
    applyReplyToMode: (payload: ReplyPayload) => payload,
  } as unknown as AgentTurnParams;
  const presentation = createAgentTurnPresentation({
    turn,
    replyMediaContext: {
      normalizePayload: async (payload) => payload,
    },
    directBlockDeliveries: options.directBlockDeliveries ?? [],
  });
  return { ...presentation, typing };
}

it.each(["direct", "buffered"] as const)(
  "applies silent-turn policy before %s delivery bookkeeping",
  async (mode) => {
    const delivered: ReplyPayload[] = [];
    const directBlockDeliveries: DirectBlockDelivery[] = [];
    const onBlockReply = (payload: ReplyPayload) => {
      delivered.push(payload);
    };
    const pipeline =
      mode === "buffered" ? createBlockReplyPipeline({ onBlockReply, timeoutMs: 0 }) : null;
    const presentation = createPresentation({
      silentExpected: true,
      directBlockDeliveries,
      onBlockReply,
      pipeline,
    });
    const { typing } = presentation;
    const blockReplyHandler = expectDefined(presentation.blockReplyHandler, "block reply handler");
    try {
      const suppressed: ReplyPayload[] = [
        { text: "Private maintenance output." },
        { mediaUrls: ["https://example.invalid/private.png"] },
        { audioAsVoice: true },
      ];
      for (const payload of suppressed) {
        await blockReplyHandler(payload);
      }
      await pipeline?.flush({ force: true });
      expect(delivered).toEqual([]);
      expect(directBlockDeliveries).toEqual([]);
      expect(pipeline?.didStream() ?? false).toBe(false);

      const permitted: ReplyPayload[] = [
        { text: "Maintenance failed.", isError: true },
        {
          text: "Spoken reply.",
          mediaUrls: ["https://example.invalid/voice.opus"],
          audioAsVoice: true,
        },
        markReplyPayloadForSourceSuppressionDelivery({
          text: "Host notice.",
          isStatusNotice: true,
        }),
      ];
      for (const payload of permitted) {
        await blockReplyHandler(payload);
        await pipeline?.flush({ force: true });
      }
      expect(delivered).toMatchObject(permitted);
    } finally {
      pipeline?.stop();
      typing.cleanup();
    }
  },
);

it("refreshes typing for whitespace appended while typing sends are failing", async () => {
  vi.useFakeTimers();
  const onCleanup = vi.fn();
  const onReplyStart = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new Error("temporary typing send failure"));
  const typing = createTypingController({ onReplyStart, onCleanup });
  const presentation = createPresentation({
    typingSignals: createTypingSignaler({ typing, mode: "message" }),
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
    const presentation = createPresentation({ onPreparedBlockReply: forwardPrepared, pipeline });
    const { typing } = presentation;
    const handler = expectDefined(presentation.blockReplyHandler, "block reply handler");
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
      ["nested", "> > ", ">> "],
      ["bulleted list", "- "],
      ["numbered list", "1. "],
      ["heading", "# "],
      ["multiline list", "- ", "  "],
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

type PreviewCase = [name: string, text: string, expected: string | null, silent?: boolean];
it.each([
  ...[
    "visible answer",
    "N",
    "NO_REPLY",
    '{"action":"NO_REPLY"}',
    "NO_REPLY\nVisible answer",
    ".NO_",
  ].map((text): PreviewCase => [text, text, text]),
  ...["HEARTBEAT_OK", "  \n", "[tool calls omitted]"].map((text): PreviewCase => [
    JSON.stringify(text),
    text,
    null,
  ]),
  [
    "heartbeat with visible suffix",
    "HEARTBEAT_OK visible after heartbeat",
    "visible after heartbeat",
  ],
  ["silent turn", "visible", null, true],
  [
    "large punctuation-prefixed preview",
    `.NOTE: ${"ordinary text ".repeat(10_000)}`,
    `.NOTE: ${"ordinary text ".repeat(10_000)}`,
  ],
] satisfies PreviewCase[])(
  "presents prepared CLI text: %s",
  async (_name, text, expected, silentExpected) => {
    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>();
    const presentation = createPresentation({ onPartialReply, silentExpected });
    await presentation.presentPartialReply({ text }, "cli");
    expect(onPartialReply.mock.calls.map(([payload]) => payload.text)).toEqual(
      expected === null ? [] : [expected],
    );
    // The final-text path must not treat an incomplete preview such as "N" as a control token.
    expect(presentation.normalizeStreamingText({ text })).toEqual(
      expected === null ? { skip: true } : { text: expected, skip: false },
    );
  },
);

it("keeps media sendable without emitting an empty text preview", async () => {
  const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>();
  const presentation = createPresentation({ onPartialReply });
  const payload = { mediaUrls: ["https://example.invalid/image.png"] };
  await presentation.presentPartialReply(payload, "cli");
  expect(onPartialReply).not.toHaveBeenCalled();
  expect(presentation.normalizeStreamingText(payload)).toEqual({ text: undefined, skip: false });
});
