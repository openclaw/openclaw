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
const defaultCoalescing = { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " };

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
    blockStreamingEnabled: true,
    blockReplyPipeline: null,
    replyToMode: "off",
    ...overrides,
  });
}

function deliveryFixture(overrides: Partial<HandlerOptions> = {}) {
  const sent: ReplyPayload[] = [];
  const directBlockDeliveries: DirectBlockDelivery[] = [];
  const handler = createHandler({
    onBlockReply: async (payload) => {
      sent.push(payload);
    },
    directBlockDeliveries,
    ...overrides,
  });
  const final = (
    payloads: ReplyPayload[],
    options: Partial<Parameters<typeof buildFinalPayloads>[0]> = {},
  ) => buildFinalPayloads({ payloads, directBlockDeliveries, ...options });
  return { sent, directBlockDeliveries, handler, final };
}

function pipelineFixture(
  options: Pick<Parameters<typeof createBlockReplyPipeline>[0], "coalescing" | "timeoutMs">,
  overrides: Partial<HandlerOptions> = {},
) {
  const sent: ReplyPayload[] = [];
  const pipeline = createBlockReplyPipeline({
    onBlockReply: async (payload) => {
      sent.push(payload);
    },
    ...options,
  });
  return { handler: createHandler({ ...overrides, blockReplyPipeline: pipeline }), sent, pipeline };
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
        coalescing: defaultCoalescing,
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

  it.each([
    "aborted",
    "failed",
    "cancelled",
    "recovery-owned",
    "completed",
    "completed-failed",
  ] as const)(
    "settles direct delivery and deduplicates only completed delivered segments: %s",
    async (outcome) => {
      const controller = new AbortController();
      const failure = new PlatformMessageNotDispatchedError("Synthetic delivery failure", {
        cause: undefined,
      });
      const completed = outcome.startsWith("completed");
      const failed = outcome === "failed" || outcome === "completed-failed";
      const delivered: string[] = [];
      const { handler, final } = deliveryFixture({
        onBlockReply: async (payload, context) => {
          context?.abortSignal?.throwIfAborted();
          if (failed) {
            throw failure;
          }
          delivered.push(payload.text ?? "");
          if (!completed) {
            setBlockReplyDelivery(
              Promise.resolve({ outcome: outcome === "cancelled" ? outcome : "recovery-owned" }),
            );
          }
        },
        blockStreamingEnabled: false,
      });
      if (outcome === "aborted") {
        controller.abort(failure);
      }
      const sending = handler(
        { text: "First answer." },
        completed
          ? { completed: true }
          : { deliveryIntentId: "independent-answer", abortSignal: controller.signal },
      );
      if (outcome === "recovery-owned" || outcome === "completed") {
        await expect(sending).resolves.toBeUndefined();
      } else if (outcome === "cancelled") {
        await expect(sending).rejects.toMatchObject({ outcome: "cancelled" });
      } else {
        await expect(sending).rejects.toBe(failure);
      }
      expect(delivered).toEqual(failed || outcome === "aborted" ? [] : ["First answer."]);
      const { replyPayloads } = await final(
        [{ text: "First answer." }, { text: "Final answer." }],
        {
          blockStreamingEnabled: false,
        },
      );
      expect(replyPayloads.map((payload) => payload.text)).toEqual(
        outcome === "completed" ? ["Final answer."] : ["First answer.", "Final answer."],
      );
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
    const enqueue = vi.fn();
    const baseParams = {
      blockReplyPipeline: { enqueue } as unknown as BlockReplyPipelineLike,
    };

    await createHandler(baseParams)(payload);
    expect(enqueue).not.toHaveBeenCalled();

    await createHandler({ ...baseParams, [enabledFlag]: true })(payload);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["isReasoning", false],
    ["isCommentary", false],
    ["isStatusNotice", true],
  ] as const)("retains final after %s (streaming=%s)", async (flag, blockStreamingEnabled) => {
    const { sent, handler, final } = deliveryFixture({
      reasoningPayloadsEnabled: true,
      commentaryPayloadsEnabled: true,
      blockStreamingEnabled,
    });

    await handler({ text: "Same answer", [flag]: true });
    const { replyPayloads } = await final([{ text: "Same answer" }], { blockStreamingEnabled });
    expect(sent).toHaveLength(1);
    expect(replyPayloads).toEqual([expect.objectContaining({ text: "Same answer" })]);
  });

  it.each<[string, ReplyPayload, string?]>([
    [
      "captioned voice",
      { text: "spoken confirmation", mediaUrls: ["/tmp/voice.opus"], audioAsVoice: true },
      "/tmp/voice.opus",
    ],
    [
      "media only",
      { mediaUrls: ["/tmp/generated.png"], replyToCurrent: true },
      "/tmp/generated.png",
    ],
    [
      "presentation only",
      {
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      },
    ],
  ])("sends %s without block streaming", async (_name, payload, mediaUrl) => {
    const onBlockReply = vi.fn(async () => {});
    const handler = createHandler({
      onBlockReply,
      blockStreamingEnabled: false,
    });
    await handler(payload);
    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ ...payload, mediaUrl }));
  });

  it.each<[string, ReplyPayload, ReplyPayload]>([
    [
      "captioned directive",
      { text: "Result\nMEDIA: ./image.png" },
      { text: "Result", mediaUrl: "./image.png", mediaUrls: ["./image.png"] },
    ],
    [
      "empty explicit list",
      { text: "MEDIA: ./report.pdf", mediaUrls: [] },
      { text: undefined, mediaUrl: "./report.pdf", mediaUrls: [] },
    ],
    [
      "plain reply",
      { text: "plain reply" },
      { text: "plain reply", mediaUrl: undefined, mediaUrls: undefined },
    ],
  ])("normalizes %s without an explicit threading opt-out", (_name, payload, expected) => {
    const normalized = normalizeReplyPayloadDirectives({
      payload,
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });
    expect(normalized.payload).toMatchObject({ ...expected, replyToCurrent: undefined });
  });

  it.each([
    { name: "prepared literal marker", text: "NO_REPLY", parsedSilent: false, expectWarning: true },
    { name: "recorded silence", text: "", parsedSilent: true, expectWarning: false },
  ])(
    "preserves $name text policy during structured block normalization",
    async ({ text, parsedSilent, expectWarning }) => {
      const blockReplyPipeline = {
        enqueue: vi.fn(),
      } as unknown as BlockReplyPipelineLike;
      const absPath = path.join("/tmp/home", "openclaw", "survived.png");
      const warning = "Media failed.";

      const handler = createHandler({
        normalizeMediaPaths: async (payload) => ({
          ...payload,
          text: warning,
          mediaUrl: absPath,
          mediaUrls: [absPath],
        }),
        blockReplyPipeline,
      });

      const payload: ReplyPayload = { text, mediaUrls: ["./missing.png", "./survived.png"] };
      if (parsedSilent) {
        setReplyPayloadMetadata(payload, { silentReply: true });
      }
      await handler(payload);

      expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expectWarning ? warning : undefined,
          mediaUrl: absPath,
          mediaUrls: [absPath],
        }),
      );
    },
  );

  it.each([false, true])(
    "uses payload identity after source text changes (coalescing=%s)",
    async (coalescing) => {
      const { handler, pipeline, sent } = pipelineFixture(
        {
          timeoutMs: 5000,
          coalescing: coalescing ? { ...defaultCoalescing, joiner: "" } : undefined,
        },
        {
          currentMessageId: "msg-123",
          replyThreading: { implicitCurrentMessage: "deny" },
          applyReplyToMode: (payload) => ({ ...payload, replyToTag: true }),
          normalizeStreamingText: (payload) => ({
            text: payload.text?.replace(/^HEARTBEAT_OK /, ""),
            skip: false,
          }),
        },
      );
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
        await handler(sourcePayload("HEARTBEAT_OK \n\n First"));
        await handler(sourcePayload("HEARTBEAT_OK Other"));
        await pipeline.flush({ force: true });

        expect(sent.map((payload) => payload.text)).toEqual(
          coalescing ? ["FirstOther"] : ["First", "Other"],
        );
        for (const payload of sent) {
          expect(payload).toMatchObject({ replyToTag: true, replyToId: undefined });
          expect(getReplyPayloadMetadata(payload)).toMatchObject({
            assistantMessageIndex: 7,
            blockSourceText: undefined,
            blockSourceRange: undefined,
          });
        }
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

it("keeps completed CLI segments distinct through coalescing and final dedupe", async () => {
  const { prepareCliReplyPayload } = await import("./cli-reply-payload.js");
  const { handler, pipeline, sent } = pipelineFixture({
    timeoutMs: 0,
    coalescing: defaultCoalescing,
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
  const { handler, final } = deliveryFixture({
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
  });
  await handler(prepareCliReplyPayload("First", undefined, 0), { completed: true });
  await handler(prepareCliReplyPayload("See [", undefined, 1), { completed: true });
  const { replyPayloads } = await final(
    [prepareCliReplyPayload("First", undefined, 0), prepareCliReplyPayload("See [", undefined, 1)],
    { blockStreamingEnabled: false },
  );
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
