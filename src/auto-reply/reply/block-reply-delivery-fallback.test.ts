import { describe, expect, it } from "vitest";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

/**
 * Integration test: when a block reply delivery fails via the dispatcher,
 * the failed payload must survive as a final payload (not be silently dropped).
 *
 * This tests the exact bug scenario where:
 * 1. Agent produces two messages: text1, text2
 * 2. Both are sent as block replies through pipeline → dispatcher
 * 3. text1 delivery fails (e.g., Telegram API error)
 * 4. text2 delivery succeeds
 * 5. BUG (before fix): shouldDropFinalPayloads=true → text1 LOST
 * 6. FIX: pipeline tracks actual delivery → text1 survives as final payload
 */
describe("block reply delivery fallback", () => {
  it("preserves failed block reply payloads as final payloads", async () => {
    const delivered: string[] = [];
    let deliveryCount = 0;

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        deliveryCount++;
        if (deliveryCount === 1) {
          throw new Error("Telegram API 400: Bad Request");
        }
        delivered.push(payload.text ?? "");
      },
      onError: () => {
        // Error handler (mirrors real dispatcher usage — logs but doesn't re-throw)
      },
    });

    // Pipeline's onBlockReply callback mirrors dispatch-from-config.ts:
    // It uses sendBlockReplyAsync and awaits actual delivery.
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        const result = dispatcher.sendBlockReplyAsync(payload);
        if (result.enqueued) {
          await result.delivered;
        }
      },
      timeoutMs: 5000,
    });

    // Simulate agent producing two block replies
    pipeline.enqueue({ text: "first message" });
    pipeline.enqueue({ text: "second message" });
    await pipeline.flush({ force: true });

    // Wait for dispatcher to finish all deliveries
    await dispatcher.waitForIdle();
    dispatcher.markComplete();

    // text1 delivery failed, text2 succeeded
    expect(delivered).toEqual(["second message"]);

    // Pipeline should accurately reflect delivery outcomes
    expect(pipeline.didStream()).toBe(true); // text2 succeeded
    expect(pipeline.isAborted()).toBe(false);
    expect(pipeline.hasSentPayload({ text: "first message" })).toBe(false); // FAILED
    expect(pipeline.hasSentPayload({ text: "second message" })).toBe(true); // SUCCEEDED

    // Now test buildReplyPayloads — it should preserve "first message" as final payload
    const { replyPayloads } = buildReplyPayloads({
      payloads: [{ text: "first message" }, { text: "second message" }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
    });

    // "first message" must survive as a final payload (not be dropped!)
    // "second message" was already streamed → should be filtered out
    expect(replyPayloads).toEqual([{ text: "first message" }]);
  });

  it("drops all final payloads when all block replies succeed", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        const result = dispatcher.sendBlockReplyAsync(payload);
        if (result.enqueued) {
          await result.delivered;
        }
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "first" });
    pipeline.enqueue({ text: "second" });
    await pipeline.flush({ force: true });
    await dispatcher.waitForIdle();
    dispatcher.markComplete();

    expect(delivered).toEqual(["first", "second"]);
    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "first" })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "second" })).toBe(true);

    const { replyPayloads } = buildReplyPayloads({
      payloads: [{ text: "first" }, { text: "second" }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
    });

    // All block replies succeeded → no final payloads needed
    expect(replyPayloads).toEqual([]);
  });

  it("falls back to all final payloads when all block replies fail", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new Error("Network error");
      },
      onError: () => {},
    });

    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        const result = dispatcher.sendBlockReplyAsync(payload);
        if (result.enqueued) {
          await result.delivered;
        }
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "first" });
    pipeline.enqueue({ text: "second" });
    await pipeline.flush({ force: true });
    await dispatcher.waitForIdle();
    dispatcher.markComplete();

    expect(pipeline.didStream()).toBe(false);

    const { replyPayloads } = buildReplyPayloads({
      payloads: [{ text: "first" }, { text: "second" }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
    });

    // All block replies failed → all payloads survive as final
    expect(replyPayloads).toEqual([{ text: "first" }, { text: "second" }]);
  });
});
