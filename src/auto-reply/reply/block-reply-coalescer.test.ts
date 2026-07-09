/** Tests the block reply coalescer's final-flush and abort-discard contract. */
import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";

const baseConfig = { minChars: 100, maxChars: 2000, idleMs: 1000, joiner: "" };

describe("createBlockReplyCoalescer final-flush contract", () => {
  // streaming.md:96 — "final flush always sends remaining text". A forced flush must
  // emit a buffered tail even when it is shorter than minChars.
  it("force-flush delivers a sub-minChars buffered tail", async () => {
    const flushed: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: baseConfig,
      shouldAbort: () => false,
      onFlush: (payload: ReplyPayload) => {
        if (payload.text) {
          flushed.push(payload.text);
        }
      },
    });

    coalescer.enqueue({ text: "short tail" });
    expect(coalescer.hasBuffered()).toBe(true);

    await coalescer.flush({ force: true });

    expect(flushed).toEqual(["short tail"]);
    expect(coalescer.hasBuffered()).toBe(false);
  });

  // Regression for #102578: once a prior streamed block timed out (shouldAbort() === true),
  // a forced final flush cannot send the buffered tail in order, but the drop must be
  // observable rather than silent. End-to-end content is re-delivered by the finals
  // fallback (shouldDropFinalPayloads is gated on !isAborted).
  it("logs, does not silently discard, a buffered tail on force-flush after abort", async () => {
    let aborted = false;
    const flushed: string[] = [];
    const logs: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: baseConfig,
      shouldAbort: () => aborted,
      logVerbose: (message) => logs.push(message),
      onFlush: (payload: ReplyPayload) => {
        if (payload.text) {
          flushed.push(payload.text);
        }
      },
    });

    coalescer.enqueue({ text: "final tail below minChars" });
    expect(coalescer.hasBuffered()).toBe(true);

    // A prior block send timed out between buffering the tail and finalization.
    aborted = true;
    await coalescer.flush({ force: true });

    // Not sent in order, but the discard is surfaced instead of being silent.
    expect(flushed).toEqual([]);
    expect(logs.some((message) => message.includes("after abort"))).toBe(true);
  });
});
