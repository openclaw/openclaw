// Tests reply delivery routing, payload persistence, and send suppression.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  createBlockReplyDeliveryHandler,
  type DirectBlockDelivery,
  normalizeReplyPayloadDirectives,
} from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

type BlockReplyPipelineLike = NonNullable<
  Parameters<typeof createBlockReplyDeliveryHandler>[0]["blockReplyPipeline"]
>;

describe("createBlockReplyDeliveryHandler", () => {
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
      normalizeStreamingText: (reply: ReplyPayload) => ({ text: reply.text, skip: false }),
      applyReplyToMode: (reply: ReplyPayload) => reply,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline: { enqueue } as unknown as BlockReplyPipelineLike,
      directBlockDeliveries: [],
    };

    await createBlockReplyDeliveryHandler(baseParams)(payload);
    expect(enqueue).not.toHaveBeenCalled();

    await createBlockReplyDeliveryHandler({ ...baseParams, [enabledFlag]: true })(payload);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    { lane: "reasoning", flag: "isReasoning", blockStreamingEnabled: false },
    { lane: "commentary", flag: "isCommentary", blockStreamingEnabled: false },
    { lane: "reasoning", flag: "isReasoning", blockStreamingEnabled: true },
    { lane: "commentary", flag: "isCommentary", blockStreamingEnabled: true },
    { lane: "status notice", flag: "isStatusNotice", blockStreamingEnabled: true },
  ] as const)(
    "preserves the final answer after directly sending $lane (streaming=$blockStreamingEnabled)",
    async ({ flag, blockStreamingEnabled }) => {
      const delivered: ReplyPayload[] = [];
      const directBlockDeliveries: DirectBlockDelivery[] = [];
      const handler = createBlockReplyDeliveryHandler({
        onBlockReply: async (payload) => {
          delivered.push(payload);
        },
        normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
        applyReplyToMode: (payload) => payload,
        typingSignals: {
          signalTextDelta: vi.fn(async () => {}),
        } as unknown as TypingSignaler,
        reasoningPayloadsEnabled: true,
        commentaryPayloadsEnabled: true,
        blockStreamingEnabled,
        blockReplyPipeline: null,
        directBlockDeliveries,
      });

      await handler({ text: "Same answer", [flag]: true });
      const { replyPayloads } = await buildReplyPayloads({
        payloads: [{ text: "Same answer" }],
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled,
        blockReplyPipeline: null,
        directBlockDeliveries,
        replyToMode: "off",
      });

      expect(delivered).toHaveLength(1);
      expect(replyPayloads).toEqual([expect.objectContaining({ text: "Same answer" })]);
    },
  );

  it("keeps a matching final answer from a different directly sent assistant message", async () => {
    const directBlockDeliveries: DirectBlockDelivery[] = [];
    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: async () => {},
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline: null,
      directBlockDeliveries,
    });

    await handler(setReplyPayloadMetadata({ text: "Same answer" }, { assistantMessageIndex: 0 }));
    const finalPayload = setReplyPayloadMetadata(
      { text: "Same answer" },
      { assistantMessageIndex: 1 },
    );
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [finalPayload],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: true,
      blockReplyPipeline: null,
      directBlockDeliveries,
      replyToMode: "off",
    });

    expect(replyPayloads).toEqual([expect.objectContaining({ text: "Same answer" })]);
  });

  it("sends captioned media-bearing block replies when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});
    const normalizeStreamingText = vi.fn((payload: { text?: string }) => ({
      text: payload.text,
      skip: false,
    }));
    const typingSignals = {
      signalTextDelta: vi.fn(async () => {}),
    } as unknown as TypingSignaler;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText,
      applyReplyToMode: (payload) => payload,
      typingSignals,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directBlockDeliveries: [],
    });

    await handler({
      text: "here's the vibe",
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
    });

    const expectedPayload = {
      text: "here's the vibe",
      mediaUrl: "/tmp/generated.png",
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
      replyToId: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
    };

    expect(onBlockReply).toHaveBeenCalledWith(expectedPayload);
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("here's the vibe");
  });

  it("sends captioned audio-as-voice block replies when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directBlockDeliveries: [],
    });

    await handler({
      text: "spoken confirmation",
      mediaUrls: ["/tmp/voice.opus"],
      audioAsVoice: true,
    });

    const expectedPayload = {
      text: "spoken confirmation",
      mediaUrl: "/tmp/voice.opus",
      mediaUrls: ["/tmp/voice.opus"],
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: true,
    };

    expect(onBlockReply).toHaveBeenCalledWith(expectedPayload);
  });

  it("sends media-only block replies when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directBlockDeliveries: [],
    });

    await handler({
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
    });

    expect(onBlockReply).toHaveBeenCalledWith({
      mediaUrl: "/tmp/generated.png",
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
      replyToId: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      text: undefined,
    });
  });

  it("sends presentation-only block replies when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
    };

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directBlockDeliveries: [],
    });

    await handler({ presentation });

    const expectedPayload = {
      presentation,
      text: undefined,
      mediaUrl: undefined,
      mediaUrls: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
    };
    expect(onBlockReply).toHaveBeenCalledWith(expectedPayload);
  });

  it("keeps text-only block replies buffered when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directBlockDeliveries: [],
    });

    await handler({ text: "text only" });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("trims leading whitespace in block-streamed replies", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directBlockDeliveries: [],
    });

    await handler({ text: "\n\n  Hello from stream" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      text: "Hello from stream",
      mediaUrl: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      mediaUrls: undefined,
    });
  });

  it("suppresses implicit current-message threading for block replies when reply threading denies it", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      currentMessageId: "msg-123",
      replyThreading: { implicitCurrentMessage: "deny" },
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directBlockDeliveries: [],
    });

    await handler({ text: "reset intro" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      text: "reset intro",
      mediaUrl: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      mediaUrls: undefined,
    });
  });

  it("parses media directives in block replies before path normalization", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "Result\nMEDIA: ./image.png" },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(normalized.payload.text).toBe("Result");
    expect(normalized.payload.mediaUrl).toBe("./image.png");
    expect(normalized.payload.mediaUrls).toEqual(["./image.png"]);
  });

  it("parses lowercase media directives in block replies before path normalization", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "media: ./report.pdf" },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(normalized.payload.text).toBeUndefined();
    expect(normalized.payload.mediaUrl).toBe("./report.pdf");
    expect(normalized.payload.mediaUrls).toEqual(["./report.pdf"]);
  });

  it("keeps parsed media when an explicit media list is empty", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "MEDIA: ./report.pdf", mediaUrls: [] },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(normalized.payload.text).toBeUndefined();
    expect(normalized.payload.mediaUrl).toBe("./report.pdf");
    expect(normalized.payload.mediaUrls).toEqual([]);
  });

  it("leaves media-looking text alone when media directive parsing is disabled", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "Result\nMEDIA: ./image.png" },
      trimLeadingWhitespace: true,
      parseMode: "auto",
      extractMediaDirectives: false,
    });

    expect(normalized.payload.text).toBe("Result\nMEDIA: ./image.png");
    expect(normalized.payload.mediaUrl).toBeUndefined();
    expect(normalized.payload.mediaUrls).toBeUndefined();
  });

  it("does not mark plain replies as explicit reply_to_current opt-outs", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "plain reply" },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(normalized.payload.replyToCurrent).toBeUndefined();
  });

  it("passes structured media block replies through media path normalization", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;
    const absPath = path.join("/tmp/home", "openclaw", "image.png");

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      normalizeMediaPaths: async (payload) => ({
        ...payload,
        mediaUrl: absPath,
        mediaUrls: [absPath],
      }),
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directBlockDeliveries: [],
    });

    await handler({ text: "Result", mediaUrl: "./image.png" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      text: "Result",
      mediaUrl: absPath,
      mediaUrls: [absPath],
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
    });
  });

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

      const handler = createBlockReplyDeliveryHandler({
        onBlockReply: vi.fn(async () => {}),
        normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
        applyReplyToMode: (payload) => payload,
        normalizeMediaPaths: async (payload) => ({
          ...payload,
          text: "⚠️ Media failed. Try sending a smaller supported file or a different format.",
          mediaUrl: absPath,
          mediaUrls: [absPath],
        }),
        typingSignals: {
          signalTextDelta: vi.fn(async () => {}),
        } as unknown as TypingSignaler,
        blockStreamingEnabled: true,
        blockReplyPipeline,
        directBlockDeliveries: [],
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

  it("preserves reply payload metadata across block-reply normalization", async () => {
    const enqueue = vi.fn();
    const blockReplyPipeline = {
      enqueue,
    } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => ({ ...payload, replyToTag: true }),
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directBlockDeliveries: [],
    });

    const payload = setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 7 });

    await handler(payload);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [firstCall] = enqueue.mock.calls;
    if (!firstCall) {
      throw new Error("Expected block reply pipeline enqueue call");
    }
    const [enqueuedPayload] = firstCall;
    if (enqueuedPayload === undefined) {
      throw new Error("Expected block reply pipeline payload");
    }
    expect(enqueuedPayload).toEqual({
      text: "Alpha",
      mediaUrl: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: true,
      audioAsVoice: false,
      mediaUrls: undefined,
    });
    expect(getReplyPayloadMetadata(enqueuedPayload)).toEqual({
      assistantMessageIndex: 7,
    });
  });

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
      const handler = createBlockReplyDeliveryHandler({
        onBlockReply: vi.fn(async () => {}),
        normalizeStreamingText: (payload) => ({
          text: payload.text?.replace(/^HEARTBEAT_OK /, ""),
          skip: false,
        }),
        applyReplyToMode: (payload) => payload,
        typingSignals: {
          signalTextDelta: vi.fn(async () => {}),
        } as unknown as TypingSignaler,
        blockStreamingEnabled: true,
        blockReplyPipeline: pipeline,
        directBlockDeliveries: [],
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
    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline: null,
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
    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: async () => {
        if (!delivered) {
          throw new PlatformMessageNotDispatchedError("Synthetic delivery failure", {
            cause: undefined,
          });
        }
      },
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: { signalTextDelta: vi.fn(async () => {}) } as unknown as TypingSignaler,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directBlockDeliveries,
    });
    const sending = handler({ text: "First answer." }, { completed: true });
    if (delivered) {
      await sending;
    } else {
      await expect(sending).rejects.toThrow("Synthetic delivery failure");
    }
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [{ text: "First answer." }, { text: "Final answer." }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directBlockDeliveries,
      replyToMode: "off",
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
  const handler = createBlockReplyDeliveryHandler({
    onBlockReply: async () => {},
    normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
    applyReplyToMode: (payload) => payload,
    typingSignals: { signalTextDelta: vi.fn(async () => {}) } as unknown as TypingSignaler,
    blockStreamingEnabled: true,
    blockReplyPipeline: pipeline,
    directBlockDeliveries: [],
  });
  try {
    await handler({ text: "Checking." });
    expect(sent).toEqual([]);
    await handler(prepareCliReplyPayload("Alpha", undefined, 0), { completed: true });
    expect(sent.map((payload) => payload.text)).toEqual(["Checking.", "Alpha"]);
    await handler(prepareCliReplyPayload("Beta", undefined, 1), { completed: true });
    await pipeline.flush({ force: true });
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [
        prepareCliReplyPayload("Alpha", undefined, 0),
        prepareCliReplyPayload("Beta", undefined, 1),
      ],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
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
  const { createBlockReplySource, setBlockReplyDelivery, recoverBlockReplySources } =
    await import("./block-reply-delivery.js");
  const { prepareCliReplyPayload } = await import("./cli-reply-payload.js");
  const source = createBlockReplySource();
  const directBlockDeliveries: DirectBlockDelivery[] = [];
  const handler = createBlockReplyDeliveryHandler({
    onBlockReply: async (payload) => {
      if (payload.text !== "See [") {
        return;
      }
      source.setComplete(false);
      await source.run(async () => {
        setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }), { text: "See " });
      });
    },
    normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
    applyReplyToMode: (payload) => payload,
    typingSignals: { signalTextDelta: vi.fn(async () => {}) } as unknown as TypingSignaler,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    directBlockDeliveries,
  });
  await handler(prepareCliReplyPayload("First", undefined, 0), { completed: true });
  await handler(prepareCliReplyPayload("See [", undefined, 1), { completed: true });
  const { replyPayloads } = await buildReplyPayloads({
    payloads: [
      prepareCliReplyPayload("First", undefined, 0),
      prepareCliReplyPayload("See [", undefined, 1),
    ],
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    directBlockDeliveries,
    replyToMode: "off",
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
