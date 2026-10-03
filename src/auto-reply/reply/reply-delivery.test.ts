// Tests reply delivery routing, payload persistence, and send suppression.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { BlockReplyContext, ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { setBlockReplyDelivery } from "./block-reply-delivery.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import {
  createBlockReplyDeliveryHandler,
  type DirectBlockDelivery,
  normalizeReplyPayloadDirectives,
} from "./reply-delivery.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { TypingSignaler } from "./typing-mode.js";

type BlockReplyPipelineLike = NonNullable<
  Parameters<typeof createBlockReplyDeliveryHandler>[0]["blockReplyPipeline"]
>;

const quietTypingSignals: TypingSignaler = {
  mode: "never",
  shouldStartImmediately: false,
  shouldStartOnMessageStart: false,
  shouldStartOnText: false,
  shouldStartOnReasoning: false,
  signalRunStart: async () => {},
  signalMessageStart: async () => {},
  signalTextDelta: async () => {},
  signalReasoningDelta: async () => {},
  signalToolStart: async () => {},
};

type HandlerOptions = Parameters<typeof createBlockReplyDeliveryHandler>[0];

function createHandler(overrides: Partial<HandlerOptions>) {
  return createBlockReplyDeliveryHandler({
    onBlockReply: async () => {},
    normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
    applyReplyToMode: (payload) => payload,
    typingSignals: quietTypingSignals,
    blockStreamingEnabled: true,
    blockReplyPipeline: null,
    directBlockDeliveries: [],
    ...overrides,
  });
}

function buildFinalPayloads(
  overrides: Pick<Parameters<typeof buildReplyPayloads>[0], "payloads"> &
    Partial<Parameters<typeof buildReplyPayloads>[0]>,
) {
  return buildReplyPayloads({
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: true,
    blockReplyPipeline: null,
    replyToMode: "off",
    ...overrides,
  });
}

describe("createBlockReplyDeliveryHandler", () => {
  it.each([false, true])(
    "delivers independent replies without buffering or completing the turn (streaming=%s)",
    async (blockStreamingEnabled) => {
      const delivered: Array<{ payload: ReplyPayload; context?: BlockReplyContext }> = [];
      const dispatcher = createReplyDispatcher({ deliver: async () => {} });
      const ledger = createReplyTurnLedger(dispatcher);
      const onBlockReply = async (payload: ReplyPayload, context?: BlockReplyContext) => {
        context?.abortSignal?.throwIfAborted();
        delivered.push({ payload, context });
        ledger.recordRoutedDelivery("block", payload, { ok: true, delivered: true });
      };
      const pipeline = createBlockReplyPipeline({
        onBlockReply,
        timeoutMs: 0,
        coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " },
      });
      const directBlockDeliveries: DirectBlockDelivery[] = [];
      const handler = createHandler({
        onBlockReply,
        blockStreamingEnabled,
        blockReplyPipeline: pipeline,
        directBlockDeliveries,
      });
      const context: BlockReplyContext = {
        deliveryIntentId: "block-reply:v1:codex-app-server:thread:turn:side-answer",
        abortSignal: new AbortController().signal,
        assistantMessageIndex: 7,
        timeoutMs: 5000,
      };
      try {
        await handler({ text: "Buffered ordinary reply." });
        await handler({ text: "The list contains Casey." }, context);

        expect(delivered).toEqual([
          { payload: expect.objectContaining({ text: "The list contains Casey." }), context },
        ]);
        expect(delivered[0]?.context).toBe(context);
        expect(pipeline.hasBuffered()).toBe(blockStreamingEnabled);
        expect(ledger.resolveTerminalDelivery()).toBe("missing");

        const { replyPayloads } = await buildFinalPayloads({
          payloads: [{ text: "The list contains Casey." }, { text: "The audit is complete." }],
          blockStreamingEnabled,
          blockReplyPipeline: pipeline,
          directBlockDeliveries,
        });
        expect(replyPayloads.map((payload) => payload.text)).toEqual([
          "The list contains Casey.",
          "The audit is complete.",
        ]);
        await pipeline.flush({ force: true });
        expect(delivered.map(({ payload }) => payload.text)).toEqual(
          blockStreamingEnabled
            ? ["The list contains Casey.", "Buffered ordinary reply."]
            : ["The list contains Casey."],
        );
      } finally {
        pipeline.stop();
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    },
  );

  it.each(["aborted", "failed", "cancelled", "recovery-owned"] as const)(
    "preserves independent delivery settlement when %s",
    async (outcome) => {
      const controller = new AbortController();
      const failure = new PlatformMessageNotDispatchedError("Synthetic delivery failure", {
        cause: undefined,
      });
      const delivered: string[] = [];
      const handler = createHandler({
        onBlockReply: async (payload, context) => {
          context?.abortSignal?.throwIfAborted();
          if (outcome === "failed") {
            throw failure;
          }
          delivered.push(payload.text ?? "");
          setBlockReplyDelivery(
            Promise.resolve({ outcome: outcome === "cancelled" ? outcome : "recovery-owned" }),
          );
        },
        blockStreamingEnabled: false,
      });
      if (outcome === "aborted") {
        controller.abort(failure);
      }
      const sending = handler(
        { text: "Independent answer." },
        { deliveryIntentId: "independent-answer", abortSignal: controller.signal },
      );
      if (outcome === "recovery-owned") {
        await expect(sending).resolves.toBeUndefined();
        expect(delivered).toEqual(["Independent answer."]);
      } else if (outcome === "cancelled") {
        await expect(sending).rejects.toMatchObject({ outcome: "cancelled" });
        expect(delivered).toEqual(["Independent answer."]);
      } else {
        await expect(sending).rejects.toBe(failure);
        expect(delivered).toEqual([]);
      }
    },
  );

  it.each([
    ["reasoning", { text: "internal reasoning", isReasoning: true }, "reasoningPayloadsEnabled"],
    [
      "commentary",
      { text: "internal commentary", isCommentary: true },
      "commentaryPayloadsEnabled",
    ],
  ] as const)("gates %s before delivery bookkeeping", async (_label, payload, enabledFlag) => {
    const onBlockReply = vi.fn(async () => {});
    const enqueue = vi.fn();
    const baseParams = {
      onBlockReply,
      blockStreamingEnabled: true,
      blockReplyPipeline: { enqueue } as unknown as BlockReplyPipelineLike,
    };

    await createHandler(baseParams)(payload);
    expect(enqueue).not.toHaveBeenCalled();

    await createHandler({ ...baseParams, [enabledFlag]: true })(payload);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    { lane: "reasoning", flag: "isReasoning", blockStreamingEnabled: false },
    { lane: "commentary", flag: "isCommentary", blockStreamingEnabled: false },
    { lane: "reasoning", flag: "isReasoning", blockStreamingEnabled: true },
    { lane: "commentary", flag: "isCommentary", blockStreamingEnabled: true },
    { lane: "status notice", flag: "isStatusNotice", blockStreamingEnabled: true },
    { lane: "different assistant message", flag: undefined, blockStreamingEnabled: true },
  ] as const)(
    "preserves the final answer after directly sending $lane (streaming=$blockStreamingEnabled)",
    async ({ flag, blockStreamingEnabled }) => {
      const delivered: ReplyPayload[] = [];
      const directBlockDeliveries: DirectBlockDelivery[] = [];
      const handler = createHandler({
        onBlockReply: async (payload) => {
          delivered.push(payload);
        },
        reasoningPayloadsEnabled: true,
        commentaryPayloadsEnabled: true,
        blockStreamingEnabled,
        directBlockDeliveries,
      });

      const sentPayload = flag
        ? { text: "Same answer", [flag]: true }
        : setReplyPayloadMetadata({ text: "Same answer" }, { assistantMessageIndex: 0 });
      const finalPayload = flag
        ? { text: "Same answer" }
        : setReplyPayloadMetadata({ text: "Same answer" }, { assistantMessageIndex: 1 });
      await handler(sentPayload);
      const { replyPayloads } = await buildFinalPayloads({
        payloads: [finalPayload],
        blockStreamingEnabled,
        directBlockDeliveries,
      });

      expect(delivered).toHaveLength(1);
      expect(replyPayloads).toEqual([expect.objectContaining({ text: "Same answer" })]);
    },
  );

  it.each<{ name: string; payload: ReplyPayload; mediaUrl?: string }>([
    {
      name: "captioned image",
      payload: { text: "here's the vibe", mediaUrls: ["/tmp/generated.png"], replyToCurrent: true },
      mediaUrl: "/tmp/generated.png",
    },
    {
      name: "captioned voice",
      payload: { text: "spoken confirmation", mediaUrls: ["/tmp/voice.opus"], audioAsVoice: true },
      mediaUrl: "/tmp/voice.opus",
    },
    {
      name: "media only",
      payload: { mediaUrls: ["/tmp/generated.png"], replyToCurrent: true },
      mediaUrl: "/tmp/generated.png",
    },
    {
      name: "presentation only",
      payload: {
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      },
    },
  ])("sends $name without block streaming", async ({ payload, mediaUrl }) => {
    const onBlockReply = vi.fn(async () => {});
    const signalTextDelta = vi.fn(async () => {});
    const handler = createHandler({
      onBlockReply,
      typingSignals: { ...quietTypingSignals, signalTextDelta },
      blockStreamingEnabled: false,
    });
    await handler(payload);
    expect(onBlockReply).toHaveBeenCalledWith({
      text: undefined,
      mediaUrls: undefined,
      replyToCurrent: undefined,
      replyToId: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      ...payload,
      mediaUrl,
    });
    if (payload.text) {
      expect(signalTextDelta).toHaveBeenCalledWith(payload.text);
    }
  });

  it.each<{
    name: string;
    payload: ReplyPayload;
    options?: Partial<HandlerOptions>;
    expected: ReplyPayload;
    metadata?: { assistantMessageIndex: number };
  }>([
    {
      name: "leading whitespace",
      payload: { text: "\n\n  Hello from stream" },
      expected: { text: "Hello from stream" },
    },
    {
      name: "denied implicit threading",
      payload: { text: "reset intro" },
      options: { currentMessageId: "msg-123", replyThreading: { implicitCurrentMessage: "deny" } },
      expected: { text: "reset intro" },
    },
    {
      name: "structured media paths",
      payload: { text: "Result", mediaUrl: "./image.png" },
      options: {
        normalizeMediaPaths: async (payload) => ({
          ...payload,
          mediaUrl: path.join("/tmp/home", "openclaw", "image.png"),
          mediaUrls: [path.join("/tmp/home", "openclaw", "image.png")],
        }),
      },
      expected: {
        text: "Result",
        mediaUrl: path.join("/tmp/home", "openclaw", "image.png"),
        mediaUrls: [path.join("/tmp/home", "openclaw", "image.png")],
      },
    },
    {
      name: "payload metadata",
      payload: { text: "Alpha" },
      options: { applyReplyToMode: (payload) => ({ ...payload, replyToTag: true }) },
      expected: { text: "Alpha", replyToTag: true },
      metadata: { assistantMessageIndex: 7 },
    },
  ])("normalizes $name before enqueueing", async ({ payload, options, expected, metadata }) => {
    const enqueue = vi.fn();
    const handler = createHandler({
      blockReplyPipeline: { enqueue } as unknown as BlockReplyPipelineLike,
      ...options,
    });
    await handler(metadata ? setReplyPayloadMetadata(payload, metadata) : payload);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({
      mediaUrl: undefined,
      mediaUrls: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      ...expected,
    });
    if (metadata) {
      expect(getReplyPayloadMetadata(enqueue.mock.calls[0]?.[0])).toEqual(metadata);
    }
  });

  it.each<{
    name: string;
    payload: ReplyPayload;
    extractMediaDirectives?: boolean;
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
  }>([
    {
      name: "captioned directive",
      payload: { text: "Result\nMEDIA: ./image.png" },
      text: "Result",
      mediaUrl: "./image.png",
      mediaUrls: ["./image.png"],
    },
    {
      name: "lowercase directive",
      payload: { text: "media: ./report.pdf" },
      mediaUrl: "./report.pdf",
      mediaUrls: ["./report.pdf"],
    },
    {
      name: "empty explicit list",
      payload: { text: "MEDIA: ./report.pdf", mediaUrls: [] },
      mediaUrl: "./report.pdf",
      mediaUrls: [],
    },
    {
      name: "disabled parsing",
      payload: { text: "Result\nMEDIA: ./image.png" },
      extractMediaDirectives: false,
      text: "Result\nMEDIA: ./image.png",
    },
    { name: "plain reply", payload: { text: "plain reply" }, text: "plain reply" },
  ])(
    "normalizes $name without an explicit threading opt-out",
    ({ payload, extractMediaDirectives, text, mediaUrl, mediaUrls }) => {
      const normalized = normalizeReplyPayloadDirectives({
        payload,
        trimLeadingWhitespace: true,
        parseMode: "auto",
        extractMediaDirectives,
      });
      expect(normalized.payload.text).toBe(text);
      expect(normalized.payload.mediaUrl).toBe(mediaUrl);
      expect(normalized.payload.mediaUrls).toEqual(mediaUrls);
      expect(normalized.payload.replyToCurrent).toBeUndefined();
    },
  );

  it.each([
    { name: "raw silence", text: "NO_REPLY", parsedSilent: false, expectWarning: false },
    { name: "parsed silence", text: "", parsedSilent: true, expectWarning: false },
    { name: "ordinary reply", text: "Caption", parsedSilent: false, expectWarning: true },
  ])(
    "preserves $name text policy during structured block normalization",
    async ({ text, parsedSilent, expectWarning }) => {
      const blockReplyPipeline = {
        enqueue: vi.fn(),
      } as unknown as BlockReplyPipelineLike;
      const absPath = path.join("/tmp/home", "openclaw", "survived.png");

      const handler = createHandler({
        onBlockReply: vi.fn(async () => {}),
        normalizeMediaPaths: async (payload) => ({
          ...payload,
          text: "⚠️ Media failed. Try sending a smaller supported file or a different format.",
          mediaUrl: absPath,
          mediaUrls: [absPath],
        }),
        blockStreamingEnabled: true,
        blockReplyPipeline,
      });

      const payload: ReplyPayload = { text, mediaUrls: ["./missing.png", "./survived.png"] };
      if (parsedSilent) {
        setReplyPayloadMetadata(payload, { silentReply: true });
      }
      await handler(payload);

      expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
        text: expectWarning
          ? "⚠️ Media failed. Try sending a smaller supported file or a different format."
          : undefined,
        mediaUrl: absPath,
        mediaUrls: [absPath],
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: undefined,
        audioAsVoice: false,
      });
    },
  );

  it.each([false, true])(
    "falls back to payload identity when normalization invalidates source text (coalescing=%s)",
    async (coalescing) => {
      const sent: ReplyPayload[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (payload) => {
          sent.push(payload);
        },
        timeoutMs: 5000,
        ...(coalescing
          ? { coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: "" } }
          : {}),
      });
      const handler = createHandler({
        onBlockReply: vi.fn(async () => {}),
        normalizeStreamingText: (payload) => ({
          text: payload.text?.replace(/^HEARTBEAT_OK /, ""),
          skip: false,
        }),
        blockStreamingEnabled: true,
        blockReplyPipeline: pipeline,
      });
      const sourcePayload = (text: string) =>
        setReplyPayloadMetadata(
          { text },
          {
            assistantMessageIndex: 7,
            blockSourceText: text,
            blockSourceRange: [0, text.length] as const,
          },
        );

      try {
        await handler(sourcePayload("HEARTBEAT_OK First"));
        await handler(sourcePayload("HEARTBEAT_OK Other"));
        await pipeline.flush({ force: true });

        expect(sent.map((payload) => payload.text)).toEqual(
          coalescing ? ["FirstOther"] : ["First", "Other"],
        );
        expect(sent.map((payload) => getReplyPayloadMetadata(payload)?.blockSourceText)).toEqual(
          coalescing ? [undefined] : [undefined, undefined],
        );
        expect(sent.map((payload) => getReplyPayloadMetadata(payload)?.blockSourceRange)).toEqual(
          coalescing ? [undefined] : [undefined, undefined],
        );
      } finally {
        try {
          await pipeline.flush({ force: true });
        } finally {
          pipeline.stop();
        }
      }
    },
  );

  it("records concurrent direct block deliveries in emission order", async () => {
    const resolvers: Array<() => void> = [];
    const directBlockDeliveries: DirectBlockDelivery[] = [];
    const handler = createHandler({
      onBlockReply: () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      blockStreamingEnabled: true,
      directBlockDeliveries,
    });

    const first = handler({ text: "first" });
    const second = handler({ text: "second" });
    const settled = Promise.allSettled([first, second]);
    try {
      expect(resolvers).toHaveLength(2);
      resolvers[1]!();
      await second;
      expect(directBlockDeliveries[0]?.pending).toBe(true);
      expect(directBlockDeliveries[1]?.pending).toBe(false);
      resolvers[0]!();
      await first;

      expect(directBlockDeliveries.map(({ payload }) => payload.text)).toEqual(["first", "second"]);
    } finally {
      for (const resolve of resolvers) {
        resolve();
      }
      // Both sends are awaited above; drain on assertion failure without replacing it.
      await settled;
    }
  });
});

it.each([true, false])(
  "deduplicates only delivered completed reply segments (delivered=%s)",
  async (delivered) => {
    const directBlockDeliveries: DirectBlockDelivery[] = [];
    const handler = createHandler({
      onBlockReply: async () => {
        if (!delivered) {
          throw new PlatformMessageNotDispatchedError("Synthetic delivery failure", {
            cause: undefined,
          });
        }
      },
      blockStreamingEnabled: false,
      directBlockDeliveries,
    });
    const sending = handler({ text: "First answer." }, { completed: true });
    if (delivered) {
      await sending;
    } else {
      await expect(sending).rejects.toThrow("Synthetic delivery failure");
    }
    const { replyPayloads } = await buildFinalPayloads({
      payloads: [{ text: "First answer." }, { text: "Final answer." }],
      blockStreamingEnabled: false,
      directBlockDeliveries,
    });
    expect(replyPayloads.map((payload) => payload.text)).toEqual(
      delivered ? ["Final answer."] : ["First answer.", "Final answer."],
    );
  },
);

it("keeps completed CLI segments distinct through coalescing and final dedupe", async () => {
  const { prepareCliReplyPayload } = await import("./cli-reply-payload.js");
  const sent: ReplyPayload[] = [];
  const pipeline = createBlockReplyPipeline({
    onBlockReply: async (payload) => {
      sent.push(payload);
    },
    timeoutMs: 0,
    coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " },
  });
  const handler = createHandler({
    onBlockReply: async () => {},
    blockStreamingEnabled: true,
    blockReplyPipeline: pipeline,
  });
  try {
    await handler({ text: "Checking." });
    expect(sent).toEqual([]);
    await handler(prepareCliReplyPayload("Alpha", undefined, 0), { completed: true });
    expect(sent.map((payload) => payload.text)).toEqual(["Checking.", "Alpha"]);
    await handler(prepareCliReplyPayload("Beta", undefined, 1), { completed: true });
    await pipeline.flush({ force: true });
    const { replyPayloads } = await buildFinalPayloads({
      payloads: [
        prepareCliReplyPayload("Alpha", undefined, 0),
        prepareCliReplyPayload("Beta", undefined, 1),
      ],
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
    });
    expect(sent.map((payload) => payload.text)).toEqual(["Checking.", "Alpha", "Beta"]);
    expect(replyPayloads).toEqual([]);
  } finally {
    try {
      await pipeline.flush({ force: true });
    } finally {
      pipeline.stop();
    }
  }
});

it("retains deferred-tail recovery after multiple completed CLI replies", async () => {
  const { createBlockReplySource, recoverBlockReplySources } =
    await import("./block-reply-delivery.js");
  const { prepareCliReplyPayload } = await import("./cli-reply-payload.js");
  const source = createBlockReplySource();
  const directBlockDeliveries: DirectBlockDelivery[] = [];
  const handler = createHandler({
    onBlockReply: async (payload) => {
      if (payload.text !== "See [") {
        return;
      }
      source.setComplete(false);
      await source.run(async () => {
        setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }), { text: "See " });
      });
    },
    blockStreamingEnabled: false,
    directBlockDeliveries,
  });
  await handler(prepareCliReplyPayload("First", undefined, 0), { completed: true });
  await handler(prepareCliReplyPayload("See [", undefined, 1), { completed: true });
  const { replyPayloads } = await buildFinalPayloads({
    payloads: [
      prepareCliReplyPayload("First", undefined, 0),
      prepareCliReplyPayload("See [", undefined, 1),
    ],
    blockStreamingEnabled: false,
    directBlockDeliveries,
  });
  expect(replyPayloads).toHaveLength(1);
  const pending = replyPayloads[0]!;
  expect(getReplyPayloadMetadata(pending)?.blockReplySources).toEqual([source]);
  source.setComplete(true);
  await source.run(async () => {
    setBlockReplyDelivery(Promise.resolve({ outcome: "failed-before-deliver" }), { text: "[" });
  });
  expect(await recoverBlockReplySources(pending, [source])).toMatchObject({
    payload: { text: "[" },
  });
});
