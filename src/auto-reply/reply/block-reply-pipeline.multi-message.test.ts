import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { setBlockReplyDelivery } from "./block-reply-delivery.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

function blockFor(text: string, assistantMessageIndex: number) {
  return setReplyPayloadMetadata({ text }, { assistantMessageIndex });
}

function sourceBlock(text: string, occurrenceId: string, mediaUrl?: string) {
  return setReplyPayloadMetadata(
    { text, ...(mediaUrl ? { mediaUrl, mediaUrls: [mediaUrl] } : {}) },
    {
      assistantMessageIndex: 1,
      assistantTranscriptSource: { occurrenceId },
    },
  );
}

describe("block reply pipeline multi-assistant-message suppression", () => {
  it.each([
    { coalescingEnabled: false, sourceRanges: false },
    { coalescingEnabled: true, sourceRanges: false },
    { coalescingEnabled: false, sourceRanges: true },
    { coalescingEnabled: true, sourceRanges: true },
  ])(
    "delivers separate source occurrences that reuse an index and content (%j)",
    async ({ coalescingEnabled, sourceRanges }) => {
      const sent: string[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: (payload) => {
          sent.push(payload.text ?? "");
        },
        timeoutMs: 5000,
        ...(coalescingEnabled
          ? { coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " } }
          : {}),
      });
      for (const occurrenceId of ["first", "retry"]) {
        const payload = sourceBlock("Same answer", occurrenceId);
        if (sourceRanges) {
          setReplyPayloadMetadata(payload, {
            blockSourceText: "Same answer",
            blockSourceRange: [0, 11],
          });
        }
        pipeline.enqueue(payload);
      }
      await pipeline.flush({ force: true });
      expect(sent).toEqual(["Same answer", "Same answer"]);
      expect(pipeline.hasSentPayload(sourceBlock("Same answer", "successor"))).toBe(false);
      expect(pipeline.hasSentExactPayload?.(sourceBlock("Same answer", "successor"))).toBe(false);
      expect(pipeline.hasSentPayload({ text: "Same answer" })).toBe(false);
    },
  );

  it.each(["stream", "direct"] as const)(
    "keeps a later source's caption and reused image after %s delivery",
    async (route) => {
      const pipeline = createBlockReplyPipeline({ onBlockReply: () => {}, timeoutMs: 5000 });
      const earlier = sourceBlock("Same answer", "first", "/tmp/reused.png");
      if (route === "stream") {
        pipeline.enqueue(earlier);
        await pipeline.flush({ force: true });
      }
      const { replyPayloads } = await buildReplyPayloads({
        payloads: [sourceBlock("Same answer", "retry", "/tmp/reused.png")],
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: route === "stream",
        blockReplyPipeline: route === "stream" ? pipeline : null,
        directBlockDeliveries:
          route === "direct" ? [{ payload: earlier, outcome: "delivered" }] : [],
        replyToMode: "off",
      });
      expect(replyPayloads).toEqual([
        expect.objectContaining({ text: "Same answer", mediaUrls: ["/tmp/reused.png"] }),
      ]);
    },
  );

  it("recognizes each fully-streamed message across a multi-message turn", async () => {
    const sent: string[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        if (payload.text) {
          sent.push(payload.text);
        }
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue(blockFor("Alpha one.", 0));
    pipeline.enqueue(blockFor("Alpha two.", 0));
    pipeline.enqueue(blockFor("Beta one.", 1));
    pipeline.enqueue(blockFor("Beta two.", 1));
    await pipeline.flush({ force: true });

    expect(sent).toEqual(["Alpha one.", "Alpha two.", "Beta one.", "Beta two."]);
    expect(pipeline.hasSentPayload({ text: "Alpha one. Alpha two." })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "Beta one. Beta two." })).toBe(true);
  });

  it("does not treat one message as covering another message's text", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue(blockFor("Alpha one.", 0));
    pipeline.enqueue(blockFor("Alpha two.", 0));
    pipeline.enqueue(blockFor("Beta one.", 1));
    pipeline.enqueue(blockFor("Beta two.", 1));
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "Alpha one. Alpha two. Beta one. Beta two." })).toBe(
      false,
    );
  });

  it("delivers matching text from separate assistant messages", async () => {
    for (const coalescing of [
      undefined,
      { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " },
    ]) {
      const sent: string[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (payload) => {
          if (payload.text) {
            sent.push(payload.text);
          }
        },
        timeoutMs: 5000,
        ...(coalescing ? { coalescing } : {}),
      });

      pipeline.enqueue(blockFor("Same answer", 0));
      pipeline.enqueue(blockFor("Same answer", 1));
      await pipeline.flush({ force: true });

      expect(sent).toEqual(["Same answer", "Same answer"]);
    }
  });

  it.each([false, true])(
    "keeps a matching final answer from a different assistant message (coalescing=%s)",
    async (coalescingEnabled) => {
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async () => {},
        timeoutMs: 5000,
        ...(coalescingEnabled
          ? { coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " } }
          : {}),
      });

      pipeline.enqueue(blockFor("Same answer", 0));
      await pipeline.flush({ force: true });
      expect(pipeline.didStreamTerminalReply?.(0)).toBe(true);
      expect(pipeline.didStreamTerminalReply?.(1)).toBe(false);
      const finalPayload = blockFor("Same answer", 1);
      const { replyPayloads } = await buildReplyPayloads({
        payloads: [finalPayload],
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: true,
        blockReplyPipeline: pipeline,
        replyToMode: "off",
      });

      expect(pipeline.hasSentExactPayload?.(finalPayload)).toBe(false);
      expect(pipeline.hasSentPayload(finalPayload)).toBe(false);
      expect(replyPayloads).toEqual([expect.objectContaining({ text: "Same answer" })]);
    },
  );

  it("retries a later message's unsent answer that matches an earlier delivered message", async () => {
    let sends = 0;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: () => {
        if (++sends === 2) {
          setBlockReplyDelivery(Promise.resolve({ outcome: "failed-before-deliver" }));
        }
      },
      timeoutMs: 5000,
    });
    const block = (assistantMessageIndex: number) =>
      setReplyPayloadMetadata(
        { text: "Done." },
        { assistantMessageIndex, assistantMessageStartIndex: assistantMessageIndex },
      );

    pipeline.enqueue(block(0));
    pipeline.enqueue(block(1));
    await pipeline.flush({ force: true });
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [setReplyPayloadMetadata({ text: "Done." }, { assistantMessageIndex: 1 })],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
    });

    expect(replyPayloads).toEqual([expect.objectContaining({ text: "Done." })]);
  });
});
