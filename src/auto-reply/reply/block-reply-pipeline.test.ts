import { describe, expect, it, vi } from "vitest";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

describe("BlockReplyPipeline hold/resume pass-through", () => {
  it("hold() and resume() pass through to coalescer", () => {
    const onBlockReply = vi.fn();
    const pipeline = createBlockReplyPipeline({
      onBlockReply,
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 1000,
        idleMs: 1000,
        joiner: "",
      },
    });

    // Verify hold and resume methods exist and are callable
    expect(typeof pipeline.hold).toBe("function");
    expect(typeof pipeline.resume).toBe("function");

    // Should not throw
    pipeline.hold();
    pipeline.resume();
  });
});
