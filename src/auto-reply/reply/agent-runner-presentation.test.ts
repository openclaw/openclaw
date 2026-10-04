import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { appendReplyMediaFailures } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createReplyOperation } from "./reply-run-registry.operation.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

function createPresentation(
  options: {
    silentExpected?: boolean;
    conversationContext?: string;
    normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
    replyOperation?: AgentTurnParams["replyOperation"];
    delivery?: Pick<
      AgentTurnParams,
      "opts" | "typingSignals" | "blockStreamingEnabled" | "blockReplyPipeline" | "applyReplyToMode"
    >;
  } = {},
) {
  const turn = {
    followupRun: { run: { silentExpected: options.silentExpected === true } },
    sessionCtx: { agentText: options.conversationContext },
    opts: undefined,
    replyOperation: options.replyOperation,
    ...options.delivery,
  } as unknown as AgentTurnParams;
  return createAgentTurnPresentation({
    turn,
    replyMediaContext: {
      normalizePayload: options.normalizeMediaPaths ?? (async (payload) => payload),
    },
    directBlockDeliveries: [],
    heartbeatState: { didLogStrip: false },
  });
}

describe("agent runner streaming presentation", () => {
  it.each([
    { name: "cleaned silent token", caption: "NO_REPLY", silent: true },
    { name: "cleaned silent envelope", caption: '{"action":"NO_REPLY"}', silent: true },
    { name: "ordinary code-literal caption", caption: "Use `NO_REPLY` literally.", silent: false },
  ])("preserves $name policy across attachment normalization", async ({ caption, silent }) => {
    const retainedMedia = "https://example.invalid/retained.png";
    const delivered = vi.fn(async (_payload: ReplyPayload) => {});
    const typing = createTypingController({});
    const presentation = createPresentation({
      normalizeMediaPaths: async (payload) => ({
        ...payload,
        text: appendReplyMediaFailures(payload.text, [
          { code: "delivery-failed", kind: "image", label: "Example" },
        ]),
        mediaUrl: retainedMedia,
        mediaUrls: [retainedMedia],
      }),
      delivery: {
        opts: { onPreparedBlockReply: async (plan) => delivered(plan.payload) },
        blockStreamingEnabled: true,
        blockReplyPipeline: null,
        applyReplyToMode: (payload) => payload,
        typingSignals: createTypingSignaler({ typing, mode: "never" }),
      },
    });
    const handler = presentation.blockReplyHandler;
    if (!handler) {
      throw new Error("expected the prepared block delivery handler");
    }
    try {
      await handler({
        text: `[tool calls omitted]\n${caption}`,
        mediaUrls: ["https://example.invalid/failed.png", retainedMedia],
      });
      expect(delivered.mock.calls.map(([payload]) => payload.text)).toEqual([
        silent
          ? ""
          : "Use `NO_REPLY` literally.\n⚠️ Example: Delivery failed. Try sending this file again.",
      ]);
      expect(
        delivered.mock.calls.map(
          ([payload]) => resolveSendableOutboundReplyParts(payload).mediaUrls,
        ),
      ).toEqual([[retainedMedia]]);
    } finally {
      typing.cleanup();
    }
  });

  it.each(["NO_REPLY", '{"action":"NO_REPLY"}'])(
    "suppresses cleaned silent blocks before coalesced prepared delivery: %s",
    async (silentText) => {
      const { createSubscribedSessionHarness } =
        await import("../../agents/embedded-agent-subscribe.e2e-harness.js");
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
      const typing = createTypingController({});
      const presentation = createPresentation({
        delivery: {
          opts: { onPreparedBlockReply: forwardPrepared },
          blockStreamingEnabled: true,
          blockReplyPipeline: pipeline,
          applyReplyToMode: (payload) => payload,
          typingSignals: createTypingSignaler({ typing, mode: "never" }),
        },
      });
      const handler = presentation.blockReplyHandler;
      if (!handler) {
        throw new Error("expected the prepared block delivery handler");
      }
      const blocks: string[] = [];
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-cleaned-silence",
        onBlockReply: async (payload) => {
          blocks.push(payload.text ?? "");
          await handler(payload);
        },
        blockReplyBreak: "text_end",
        blockReplyChunking: {
          minChars: 1,
          maxChars: 1200,
          breakPreference: "paragraph",
          flushOnParagraph: true,
        },
      });
      const source = `First.\n\n[tool calls omitted]\n${silentText}\n\nLast.\n\n`;
      const message = makeAgentAssistantMessage({
        api: "google-generative-ai",
        provider: "google",
        model: "gemini-2.5-flash",
        content: [{ type: "text", text: source }],
      });
      try {
        emit({ type: "message_start", message: { ...message, content: [] } });
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: source,
            partial: message,
          },
        });
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: source,
            partial: message,
          },
        });
        emit({ type: "message_end", message });
        await subscription.waitForPendingEvents();
        await pipeline.flush({ force: true });
        await dispatcher.waitForIdle();

        expect(blocks).toEqual(["First.", `[tool calls omitted]\n${silentText}`, "Last."]);
        expect(delivered.mock.calls.map(([payload]) => payload.text)).toEqual(["First.\n\nLast."]);
      } finally {
        subscription.unsubscribe();
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

  const promptCases: Array<{
    name: string;
    context: string;
    copied: string;
    answer?: string;
    skippedLengths?: number[];
  }> = [
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
    ).map(([name, prefix, continuation]) => ({
      name,
      context: historyContext,
      copied: wrap(historyContext, prefix, continuation),
      answer: "Visible streamed answer.",
    })),
    ...(
      [
        ["bulleted", "- ", "- ", "- "],
        ["quoted", "> ", "> ", "> "],
        ["indented", "    ", "    ", "    "],
        ["indented list", "- ", "    ", "    "],
        ["prompt-owned bullet", "- ", "    ", "- "],
        ["prompt-owned quote", "> ", ">> ", "> "],
      ] satisfies Array<[string, string, string, string]>
    ).map(([name, prefix, continuation, sourcePrefix]) => {
      const context = `${marker}\n${sourcePrefix}private inbound paragraph`;
      return { name, context, copied: wrap(context, prefix, continuation) };
    }),
    {
      name: "same-line answer",
      context: currentContext,
      copied: wrap(currentContext, "Visible answer: ", "> "),
    },
    {
      name: "carriage returns",
      context: currentContext,
      copied: currentContext.replace(/\n/g, "\r"),
      answer: "Visible answer.",
    },
    {
      name: "repeated source marker",
      context: repeatedContext,
      copied: wrap(repeatedContext, "- ", " ".repeat(320)),
    },
    {
      name: "unwrapped history",
      context: historyContext,
      copied: historyContext,
      answer: "Visible streamed answer.",
      skippedLengths: [1, 9, 50, 74, historyContext.length - 1],
    },
    ...["private", "private inbound"].map((privatePrefix) => ({
      name: `marker flood: ${privatePrefix}`,
      context: currentContext,
      copied: `${marker}\n`.repeat(32) + privatePrefix,
    })),
    ...['<function_calls><invoke name="exec">private XML</invoke></function_calls>'].map((xml) => {
      const context = historyContext.replace(
        "private inbound paragraph",
        `${xml}\nprivate inbound paragraph`,
      );
      return { name: "XML cleanup", context, copied: context, answer: "Visible streamed answer." };
    }),
  ];
  it.each(promptCases)(
    "withholds private prompt bytes: $name",
    ({ context, copied, answer, skippedLengths }) => {
      const presentation = createPresentation({ conversationContext: context });
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

  it("classifies streaming control tokens without changing final text", () => {
    const cases: Array<{
      payload: ReplyPayload;
      options?: Parameters<typeof createPresentation>[0];
      expected: { text?: string; skip: boolean };
    }> = [
      { payload: { text: "visible answer" }, expected: { text: "visible answer", skip: false } },
      { payload: { text: "H" }, expected: { text: "H", skip: false } },
      {
        payload: { text: "HEARTBEAT_OK visible after heartbeat" },
        expected: { text: "visible after heartbeat", skip: false },
      },
      ...[
        "N",
        "NO_",
        "NO_REPLY",
        "HEARTBEAT_",
        "HEARTBEAT_OK",
        " ",
        "  ",
        "  \n",
        "[tool calls omitted]",
      ].map((text) => ({ payload: { text }, expected: { skip: true } })),
      { payload: { text: "NO_REPLYVisible" }, expected: { text: "Visible", skip: false } },
      {
        payload: { text: "NO_REPLYVisible answer" },
        expected: { text: "Visible answer", skip: false },
      },
      {
        payload: { mediaUrls: ["https://example.invalid/image.png"] },
        expected: { text: undefined, skip: false },
      },
      { payload: { text: "visible" }, options: { silentExpected: true }, expected: { skip: true } },
      {
        payload: { text: "HEARTBEAT_OK details" },
        expected: { text: "details", skip: false },
      },
      {
        payload: { text: "No, that is wrong." },
        expected: { text: "No, that is wrong.", skip: false },
      },
    ];
    for (const { payload, options, expected } of cases) {
      const presentation = createPresentation(options);
      const classified = presentation.classifyStreamingPartial(payload);
      const actual =
        classified.skip || !classified.text
          ? classified
          : presentation.sanitizeStreamingText(classified.text, Boolean(payload.isError));
      expect(actual).toEqual(expected);
      if (options || payload.text === "No, that is wrong.") {
        expect(classified).toEqual(expected);
      }
      if (payload.text === "N") {
        // Final text is not an incomplete cumulative preview (#122476).
        expect(classified).toEqual({ skip: true });
        expect(presentation.normalizeStreamingText(payload)).toEqual({ text: "N", skip: false });
      }
    }
  });

  it("holds punctuation-prefixed silent previews until they diverge or finish", () => {
    const presentation = createPresentation();

    for (const text of [".N", ". N", "- N", ".NO", ".NO_", ".NO_REPL", "*NO_", '"NO_', "（NO_"]) {
      expect(presentation.classifyStreamingPartial({ text })).toEqual({ skip: true });
    }
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
      expect(presentation.classifyStreamingPartial({ text })).toEqual({ text, skip: false });
    }
    for (const text of [".NO", ".N", ". N", "- N", "*NO_", '"NO_', "（NO_", ".", "*"]) {
      expect(presentation.normalizeStreamingText({ text })).toEqual({ text, skip: false });
    }
  });

  it("keeps large ordinary previews visible after a punctuation prefix", () => {
    const presentation = createPresentation();
    const text = `.NOTE: ${"ordinary text ".repeat(10_000)}`;

    expect(presentation.classifyStreamingPartial({ text })).toEqual({ text, skip: false });
  });
});
