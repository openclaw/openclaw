import { expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { setBlockReplyDelivery } from "./block-reply-delivery.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

function blockFor(
  text: string,
  assistantMessageIndex: number,
  assistantMessageStartIndex?: number,
) {
  return setReplyPayloadMetadata({ text }, { assistantMessageIndex, assistantMessageStartIndex });
}

function createPipeline(coalescing = false, afterSend?: () => void) {
  const sent: string[] = [];
  const pipeline = createBlockReplyPipeline({
    onBlockReply: async (payload) => {
      if (payload.text) {
        sent.push(payload.text);
      }
      afterSend?.();
    },
    timeoutMs: 5000,
    ...(coalescing ? { coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " } } : {}),
  });
  return { pipeline, sent };
}

function finalPayloads(pipeline: ReturnType<typeof createBlockReplyPipeline>, text: string) {
  return buildReplyPayloads({
    payloads: [blockFor(text, 1)],

    blockStreamingEnabled: true,
    blockReplyPipeline: pipeline,
    replyToMode: "off",
  });
}

function sourceBlock(text: string, itemId: string, mediaUrl?: string) {
  return setReplyPayloadMetadata(
    { text, ...(mediaUrl ? { mediaUrl, mediaUrls: [mediaUrl] } : {}) },
    { assistantMessageIndex: 1, assistantTranscriptSource: { itemId } },
  );
}

it.each([
  { coalescing: false, sourceRanges: false },
  { coalescing: true, sourceRanges: false },
  { coalescing: false, sourceRanges: true },
  { coalescing: true, sourceRanges: true },
])("delivers distinct occurrences reusing the same index and content (%j)", async (scenario) => {
  const { pipeline, sent } = createPipeline(scenario.coalescing);
  for (const itemId of ["first", "retry"]) {
    const payload = sourceBlock("Same answer", itemId);
    if (scenario.sourceRanges) {
      setReplyPayloadMetadata(payload, {
        blockSourceText: "Same answer",
        blockSourceRange: [0, 11],
      });
    }
    pipeline.enqueue(payload);
    // Replaying this occurrence must not send it again.
    pipeline.enqueue(payload);
  }
  await pipeline.flush({ force: true });
  expect(sent).toEqual(["Same answer", "Same answer"]);
  expect(pipeline.hasSentPayload(sourceBlock("Same answer", "successor"))).toBe(false);
  expect(pipeline.hasSentExactPayload?.(sourceBlock("Same answer", "successor"))).toBe(false);
  expect(pipeline.hasSentPayload({ text: "Same answer" })).toBe(false);
});

it.each(["stream", "direct"] as const)(
  "keeps a later occurrence's caption and reused image after %s delivery",
  async (route) => {
    const { pipeline } = createPipeline();
    const earlier = sourceBlock("Same answer", "first", "/tmp/reused.png");
    if (route === "stream") {
      pipeline.enqueue(earlier);
      await pipeline.flush({ force: true });
    }
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [sourceBlock("Same answer", "retry", "/tmp/reused.png")],
      blockStreamingEnabled: route === "stream",
      blockReplyPipeline: route === "stream" ? pipeline : null,
      directBlockDeliveries: route === "direct" ? [{ payload: earlier, outcome: "delivered" }] : [],
      replyToMode: "off",
    });
    expect(replyPayloads).toEqual([
      expect.objectContaining({ text: "Same answer", mediaUrls: ["/tmp/reused.png"] }),
    ]);
  },
);

it("recognizes each fully-streamed message across a multi-message turn", async () => {
  const { pipeline, sent } = createPipeline();

  pipeline.enqueue(blockFor("Alpha one.", 0));
  pipeline.enqueue(blockFor("Alpha two.", 0));
  pipeline.enqueue(blockFor("Beta one.", 1));
  pipeline.enqueue(blockFor("Beta two.", 1));
  await pipeline.flush({ force: true });

  expect(sent).toEqual(["Alpha one.", "Alpha two.", "Beta one.", "Beta two."]);
  expect(pipeline.hasSentPayload({ text: "Alpha one. Alpha two." })).toBe(true);
  expect(pipeline.hasSentPayload({ text: "Beta one. Beta two." })).toBe(true);
  expect(pipeline.hasSentPayload({ text: "Alpha one. Alpha two. Beta one. Beta two." })).toBe(
    false,
  );
});

it("delivers matching text from separate assistant messages", async () => {
  for (const coalescing of [false, true]) {
    const { pipeline, sent } = createPipeline(coalescing);

    pipeline.enqueue(blockFor("Same answer", 0));
    pipeline.enqueue(blockFor("Same answer", 1));
    await pipeline.flush({ force: true });

    expect(sent).toEqual(["Same answer", "Same answer"]);
  }
});

it.each([false, true])(
  "keeps a matching final answer from a different assistant message (coalescing=%s)",
  async (coalescingEnabled) => {
    const { pipeline } = createPipeline(coalescingEnabled);

    pipeline.enqueue(blockFor("Same answer", 0));
    await pipeline.flush({ force: true });
    const finalPayload = blockFor("Same answer", 1);
    const { replyPayloads } = await finalPayloads(pipeline, "Same answer");
    expect(pipeline.didStreamTerminalReply?.(0)).toBe(true);
    expect(pipeline.didStreamTerminalReply?.(1)).toBe(false);
    expect(pipeline.hasSentExactPayload?.(finalPayload)).toBe(false);
    expect(pipeline.hasSentPayload(finalPayload)).toBe(false);
    expect(replyPayloads).toEqual([expect.objectContaining({ text: "Same answer" })]);
  },
);

it("retries a later message's unsent answer that matches an earlier delivered message", async () => {
  let sends = 0;
  const { pipeline } = createPipeline(false, () => {
    if (++sends === 2) {
      setBlockReplyDelivery(Promise.resolve({ outcome: "failed-before-deliver" }));
    }
  });
  pipeline.enqueue(blockFor("Done.", 0, 0));
  pipeline.enqueue(blockFor("Done.", 1, 1));
  await pipeline.flush({ force: true });
  const { replyPayloads } = await finalPayloads(pipeline, "Done.");

  expect(replyPayloads).toEqual([expect.objectContaining({ text: "Done." })]);
});
