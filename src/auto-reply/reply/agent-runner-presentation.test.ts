import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it, vi } from "vitest";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { appendReplyMediaFailures } from "../reply-payload.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createReplyOperation } from "./reply-run-registry.operation.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

function normalizeStreamingTextReference(
  payload: ReplyPayload,
  options: { isHeartbeat?: boolean; silentExpected?: boolean } = {},
): { text?: string; skip: boolean } {
  let text = payload.text;
  const reply = resolveSendableOutboundReplyParts(payload);
  if (options.silentExpected) {
    return { skip: true };
  }
  if (!options.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.shouldSkip && !reply.hasMedia) {
      return { skip: true };
    }
    text = stripped.text;
  }
  if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
    return { skip: true };
  }
  if (
    isSilentReplyPrefixText(text, SILENT_REPLY_TOKEN) ||
    isSilentReplyPrefixText(text, HEARTBEAT_TOKEN)
  ) {
    return { skip: true };
  }
  if (text && startsWithSilentToken(text, SILENT_REPLY_TOKEN)) {
    text = stripLeadingSilentToken(text, SILENT_REPLY_TOKEN);
  }
  if (!text) {
    return reply.hasMedia ? { text: undefined, skip: false } : { skip: true };
  }
  const sanitized = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  return sanitized.trim() ? { text: sanitized, skip: false } : { skip: true };
}

function createPresentation(
  options: {
    isHeartbeat?: boolean;
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
    isHeartbeat: options.isHeartbeat === true,
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
    directlySentBlockKeys: new Set(),
    directBlockDeliveries: [],
    heartbeatState: { didLogStrip: false },
  });
}

function cumulativePrefixes(text: string, seed: number): string[] {
  const prefixes: string[] = [];
  let offset = 0;
  let random = seed >>> 0;
  while (offset < text.length) {
    random = (random * 1_664_525 + 1_013_904_223) >>> 0;
    offset = Math.min(text.length, offset + 1 + (random % 7));
    prefixes.push(text.slice(0, offset));
  }
  return prefixes;
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
        typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
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
          typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
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

  it("redacts copied inbound prompts before streamed XML cleanup", () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");
    const presentation = createPresentation({ conversationContext });

    expect(
      presentation.normalizeStreamingText({
        text: `${conversationContext}\n\nVisible streamed answer.`,
      }),
    ).toEqual({ text: "Visible streamed answer.", skip: false });
  });

  it("withholds cumulative copied-prompt prefixes before any private stream text is visible", () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "Alice: private history",
      "",
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const presentation = createPresentation({ conversationContext });

    for (const length of [1, 9, 50, 74, conversationContext.length - 1]) {
      expect(
        presentation.normalizeStreamingText({ text: conversationContext.slice(0, length) }),
      ).toEqual({
        skip: true,
      });
    }

    expect(
      presentation.normalizeStreamingText({
        text: `${conversationContext}\n\nVisible streamed answer.`,
      }),
    ).toEqual({ text: "Visible streamed answer.", skip: false });
  });

  it.each([
    { name: "standard", prefix: "> " },
    { name: "indented", prefix: "  > " },
    { name: "nested", prefix: ">> " },
    { name: "spaced nested", prefix: "> > " },
    { name: "four-space code", prefix: "    " },
    { name: "tab-indented code", prefix: "\t" },
    { name: "bulleted list", prefix: "- " },
    { name: "numbered list", prefix: "1. " },
    { name: "heading", prefix: "# " },
    { name: "deep heading", prefix: "###### " },
    { name: "quoted heading", prefix: "> ## " },
    { name: "multiline list item", prefix: "- ", continuation: "  " },
    { name: "widely indented list item", prefix: "- ", continuation: "    " },
    { name: "varying quote depth", prefix: "> ", continuation: ">> " },
    { name: "quoted list continuation", prefix: "> - ", continuation: ">   " },
    { name: "mixed code indentation", prefix: "    ", continuation: "\t" },
    { name: "quoted continuation after an unwrapped marker", prefix: "", continuation: "> " },
    { name: "very wide list continuation", prefix: "- ", continuation: " ".repeat(320) },
    { name: "deeply nested quote", prefix: "> ", continuation: `${">".repeat(320)} ` },
  ])(
    "withholds $name Markdown prompt bytes before private stream text is visible",
    ({ prefix, continuation }) => {
      const conversationContext = [
        "[Chat messages since your last reply - for context]",
        "Alice: private history",
        "",
        "[Current message - respond to this]",
        "private inbound paragraph",
      ].join("\n");
      const quotedContext = conversationContext
        .split("\n")
        .map((line, index) => `${index === 0 ? prefix : (continuation ?? prefix)}${line}`)
        .join("\n");
      const presentation = createPresentation({ conversationContext });

      for (let length = 1; length <= quotedContext.length; length += 1) {
        const visibleText =
          presentation.normalizeStreamingText({ text: quotedContext.slice(0, length) }).text ?? "";

        expect(visibleText).not.toContain("Alice");
        expect(visibleText).not.toContain("private inbound");
      }

      expect(
        presentation.normalizeStreamingText({
          text: `${quotedContext}\n\nVisible streamed answer.`,
        }),
      ).toEqual({ text: "Visible streamed answer.", skip: false });
    },
  );

  it("withholds decorated prompt continuations after safe same-line reply text", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const wrappedContext = conversationContext
      .split("\n")
      .map((line, index) => `${index === 0 ? "Visible answer: " : "> "}${line}`)
      .join("\n");
    const presentation = createPresentation({ conversationContext });

    for (let length = 1; length <= wrappedContext.length; length += 1) {
      const visibleText =
        presentation.normalizeStreamingText({ text: wrappedContext.slice(0, length) }).text ?? "";

      expect(visibleText).not.toContain("private");
    }
  });

  it("withholds every copied prompt prefix with bare carriage-return separators", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const copiedContext = conversationContext.replace(/\n/g, "\r");
    const presentation = createPresentation({ conversationContext });

    for (let length = 1; length <= copiedContext.length; length += 1) {
      const visibleText =
        presentation.normalizeStreamingText({ text: copiedContext.slice(0, length) }).text ?? "";

      expect(visibleText).not.toContain("private");
    }

    expect(
      presentation.normalizeStreamingText({ text: `${copiedContext}\n\nVisible answer.` }),
    ).toEqual({ text: "Visible answer.", skip: false });
  });

  it("keeps the original prompt anchor when private context repeats its first marker", () => {
    const marker = "[Current message - respond to this]";
    const conversationContext = [
      marker,
      "private first paragraph",
      marker,
      "private final paragraph",
    ].join("\n");
    const wrappedContext = conversationContext
      .split("\n")
      .map((line, index) => `${index === 0 ? "- " : " ".repeat(320)}${line}`)
      .join("\n");
    const presentation = createPresentation({ conversationContext });

    for (let length = 1; length <= wrappedContext.length; length += 1) {
      const visibleText =
        presentation.normalizeStreamingText({ text: wrappedContext.slice(0, length) }).text ?? "";

      expect(visibleText).not.toContain("private");
    }
  });

  it("preserves bracket-heavy streamed text without treating every bracket as a prompt", () => {
    const marker = "[Current message - respond to this]";
    const conversationContext = `${marker}\nprivate inbound paragraph`;
    const visibleText = `${marker}${"[".repeat(40_000)}`;
    const presentation = createPresentation({ conversationContext });

    const result = presentation.normalizeStreamingText({ text: visibleText });

    expect(result.skip).toBe(false);
    expect(result.text?.length).toBe(visibleText.length - 1);
    expect(result.text?.startsWith(marker)).toBe(true);
  });

  it("withholds repeated prompt markers before their private streaming continuation", () => {
    const marker = "[Current message - respond to this]";
    const conversationContext = `${marker}\nprivate inbound paragraph`;
    const presentation = createPresentation({ conversationContext });
    const repeatedMarkers = `${marker}\n`.repeat(32);

    for (const privatePrefix of ["private", "private inbound"]) {
      const visibleText =
        presentation.normalizeStreamingText({ text: `${repeatedMarkers}${privatePrefix}` }).text ??
        "";

      expect(visibleText).not.toContain("private");
    }
  });

  it.each([
    { name: "bulleted", prefix: "- ", sourcePrefix: "- " },
    { name: "quoted", prefix: "> ", sourcePrefix: "> " },
    { name: "indented", prefix: "    ", sourcePrefix: "    " },
    {
      name: "list continuation with prompt indentation",
      prefix: "- ",
      continuation: "    ",
      sourcePrefix: "    ",
    },
    {
      name: "list continuation with a prompt-owned bullet",
      prefix: "- ",
      continuation: "    ",
      sourcePrefix: "- ",
    },
    {
      name: "varying quote depth with a prompt-owned quote",
      prefix: "> ",
      continuation: ">> ",
      sourcePrefix: "> ",
    },
  ])(
    "withholds $name wrappers without consuming prompt-owned Markdown",
    ({ prefix, continuation, sourcePrefix }) => {
      const conversationContext = [
        "[Current message - respond to this]",
        `${sourcePrefix}private inbound paragraph`,
      ].join("\n");
      const wrappedContext = conversationContext
        .split("\n")
        .map((line, index) => `${index === 0 ? prefix : (continuation ?? prefix)}${line}`)
        .join("\n");
      const presentation = createPresentation({ conversationContext });

      for (let length = 1; length <= wrappedContext.length; length += 1) {
        const visibleText =
          presentation.normalizeStreamingText({ text: wrappedContext.slice(0, length) }).text ?? "";

        expect(visibleText).not.toContain("private");
      }
    },
  );

  it("withholds a trailing copied-prompt prefix without hiding safe preceding streamed text", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const presentation = createPresentation({ conversationContext });

    expect(
      presentation.normalizeStreamingText({
        text: `Safe introductory answer.\n${conversationContext.slice(0, 12)}`,
      }),
    ).toEqual({ text: "Safe introductory answer.\n", skip: false });

    expect(
      presentation.normalizeStreamingText({
        text: `Safe introductory answer: ${conversationContext.slice(0, 12)}`,
      }),
    ).toEqual({ text: "Safe introductory answer: ", skip: false });

    expect(
      presentation.normalizeStreamingText({
        text: `\`\`\`text\n${conversationContext.slice(0, 12)}`,
      }),
    ).toEqual({ text: "```text\n", skip: false });
  });

  it("keeps long newline-heavy answers visible without copying every remaining line suffix", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const visibleAnswer = Array.from({ length: 2_000 }, (_, index) => `Visible line ${index}`).join(
      "\n",
    );
    const presentation = createPresentation({ conversationContext });

    expect(presentation.normalizeStreamingText({ text: visibleAnswer })).toEqual({
      text: visibleAnswer,
      skip: false,
    });
  });

  it("keeps split classification and sanitization equivalent to the eager path", () => {
    const presentation = createPresentation();
    const randomSequences = Array.from({ length: 16 }, (_, index) =>
      cumulativePrefixes(
        `Randomized answer ${index + 1}: alpha beta gamma delta epsilon.`,
        0xc0ffee + index,
      ).map((text) => ({ text })),
    );
    const sequences: ReplyPayload[][] = [
      ...randomSequences,
      cumulativePrefixes("HEARTBEAT_OK visible after heartbeat", 41).map((text) => ({ text })),
      ["N", "NO_", "NO_REPLY"].map((text) => ({ text })),
      [{ text: "NO_REPLYVisible" }, { text: "NO_REPLYVisible answer" }],
      [" ", "  ", "  \n"].map((text) => ({ text })),
      [{ text: "[tool calls omitted]" }],
      [{ mediaUrls: ["https://example.invalid/image.png"] }],
    ];

    for (const partials of sequences) {
      for (const payload of partials) {
        const expected = normalizeStreamingTextReference(payload);
        const classified = presentation.classifyStreamingPartial(payload);
        const actual =
          classified.skip || !classified.text
            ? classified
            : presentation.sanitizeStreamingText(classified.text, Boolean(payload.isError));
        expect(actual).toEqual(expected);
      }
    }
  });

  it("keeps silent-expected and heartbeat-run classification eager", () => {
    const silentPresentation = createPresentation({ silentExpected: true });
    expect(silentPresentation.classifyStreamingPartial({ text: "visible" })).toEqual({
      skip: true,
    });

    const heartbeatPresentation = createPresentation({ isHeartbeat: true });
    expect(
      heartbeatPresentation.classifyStreamingPartial({ text: "HEARTBEAT_OK details" }),
    ).toEqual({
      text: "HEARTBEAT_OK details",
      skip: false,
    });
  });
});
