import { describe, expect, it } from "vitest";
import type { CurrentInboundPromptContext } from "../../../agents/embedded-agent-runner/run/params.js";
import { createQueueTestRun } from "../queue.test-helpers.js";
import { collectCurrentInboundContext } from "./current-inbound-context.js";

function createRun(prompt: string, currentInboundContext?: CurrentInboundPromptContext) {
  return { ...createQueueTestRun({ prompt }), currentInboundContext };
}

describe("collectCurrentInboundContext", () => {
  it("returns the exact context for one queued item", () => {
    const currentInboundContext = { text: "context", promptJoiner: " " } as const;

    expect(collectCurrentInboundContext([createRun("first", currentInboundContext)])).toBe(
      currentInboundContext,
    );
  });

  it("combines text while taking the newest queued item's reply anchor", () => {
    const collected = collectCurrentInboundContext([
      createRun("first", {
        text: "context one",
        reply: {
          replyTargetPresent: true,
          quotePresent: false,
          replyChainPresent: false,
        },
        replyIdentifiers: { replyToId: "first-reply" },
      }),
      createRun("second", {
        text: "context two",
        reply: {
          replyTargetPresent: true,
          quotePresent: true,
          replyChainPresent: false,
        },
        replyIdentifiers: { replyToId: "second-reply" },
      }),
    ]);

    expect(collected).toMatchObject({
      text: "Queued #1 context:\ncontext one\n\nQueued #2 context:\ncontext two",
      promptJoiner: "\n\n",
      reply: {
        replyTargetPresent: true,
        quotePresent: true,
        replyChainPresent: false,
      },
      replyIdentifiers: { replyToId: "second-reply" },
    });
  });

  it("keeps a metadata-only newest reply anchor", () => {
    const collected = collectCurrentInboundContext([
      createRun("first"),
      createRun("second", {
        text: "",
        reply: {
          replyTargetPresent: true,
          quotePresent: false,
          replyChainPresent: false,
        },
      }),
    ]);

    expect(collected).toMatchObject({
      text: "",
      reply: {
        replyTargetPresent: true,
        quotePresent: false,
        replyChainPresent: false,
      },
    });
  });
});
