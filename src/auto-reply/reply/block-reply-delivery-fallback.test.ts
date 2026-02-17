import { describe, expect, it } from "vitest";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

/**
 * Integration test: when a block reply delivery fails via the dispatcher,
 * the failed payload must survive as a final payload (not be silently dropped).
 *
 * This tests the exact bug scenario from #15772 where:
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

    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        const result = dispatcher.sendBlockReplyAsync(payload);
        if (result.enqueued) {
          result.delivered.catch(() => {});
          await result.delivered;
        }
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "first message" });
    pipeline.enqueue({ text: "second message" });
    await pipeline.flush({ force: true });
    await dispatcher.waitForIdle();
    dispatcher.markComplete();

    expect(delivered).toEqual(["second message"]);

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(false);
    expect(pipeline.hasSentPayload({ text: "first message" })).toBe(false);
    expect(pipeline.hasSentPayload({ text: "second message" })).toBe(true);

    const { replyPayloads } = buildReplyPayloads({
      payloads: [{ text: "first message" }, { text: "second message" }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
    });

    // "first message" must survive as a final payload (not be dropped!)
    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("first message");
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
          result.delivered.catch(() => {});
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

    const { replyPayloads } = buildReplyPayloads({
      payloads: [{ text: "first" }, { text: "second" }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
    });

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
          result.delivered.catch(() => {});
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

    expect(replyPayloads).toHaveLength(2);
    expect(replyPayloads[0]?.text).toBe("first");
    expect(replyPayloads[1]?.text).toBe("second");
  });
});
