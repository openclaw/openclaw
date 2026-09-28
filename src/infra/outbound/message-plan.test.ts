// Verifies outbound text/media send-unit planning, chunking, captions, and
// single-use implicit reply consumption.
import { describe, expect, it } from "vitest";
import { chunkMarkdownText, chunkText } from "../../auto-reply/chunk.js";
import { planOutboundMediaMessageUnits, planOutboundTextMessageUnits } from "./message-plan.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";

describe("outbound message planning", () => {
  it.each([
    {
      name: "plain text",
      text: "aa bb cc dd",
      limit: 6,
      chunker: chunkText,
      chunkerMode: "text",
      chunkMode: "length",
      expected: ["aa bb", "cc dd"],
    },
    {
      name: "unfenced Markdown",
      text: "aa bb\ncc dd\nee ff gg hh",
      limit: 6,
      chunker: chunkMarkdownText,
      chunkerMode: "markdown",
      chunkMode: "length",
      expected: ["aa bb", "cc dd", "ee ff", "gg hh"],
    },
    {
      name: "Markdown paragraphs",
      text: "first\n\nsecond",
      limit: 6,
      chunker: chunkMarkdownText,
      chunkerMode: "markdown",
      chunkMode: "newline",
      expected: ["first", "second"],
    },
    {
      name: "fenced Markdown",
      text: "```txt\naa\nbb\ncc\n```",
      limit: 16,
      chunker: chunkMarkdownText,
      chunkerMode: "markdown",
      chunkMode: "length",
      expected: ["```txt\naa\nbb\n```", "```txt\ncc\n```"],
    },
  ] as const)("plans $name with one implicit reply", (testCase) => {
    const policy = createReplyToDeliveryPolicy({
      replyToId: "reply-1",
      replyToMode: "first",
    });
    const reply = policy.resolveCurrentReplyTo({});
    const units = planOutboundTextMessageUnits({
      text: testCase.text,
      textLimit: testCase.limit,
      chunker: testCase.chunker,
      chunkerMode: testCase.chunkerMode,
      chunkMode: testCase.chunkMode,
      overrides: { replyToId: reply.replyToId, replyToIdSource: reply.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });

    expect(units).toEqual(
      testCase.expected.map((text, index) => ({
        kind: "text",
        text,
        overrides: {
          replyToId: index === 0 ? "reply-1" : undefined,
          replyToIdSource: "implicit",
          deliveryPartIndex: index,
          deliveryPartCount: testCase.expected.length,
        },
      })),
    );
  });

  it.each([
    { label: "default", chunkMode: undefined },
    { label: "newline", chunkMode: "newline" as const },
  ])("preserves nonempty text when a $label chunker returns nothing", ({ chunkMode }) => {
    const policy = createReplyToDeliveryPolicy({ replyToId: "reply-1", replyToMode: "first" });
    const reply = policy.resolveCurrentReplyTo({});
    const units = planOutboundTextMessageUnits({
      text: "visible reply",
      textLimit: 64,
      chunkMode,
      chunker: () => [],
      overrides: { replyToId: reply.replyToId, replyToIdSource: reply.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });

    expect(units).toEqual([
      {
        kind: "text",
        text: "visible reply",
        overrides: {
          replyToId: "reply-1",
          replyToIdSource: "implicit",
          deliveryPartIndex: 0,
          deliveryPartCount: 1,
        },
      },
    ]);
  });

  it("keeps explicit text replies from consuming the implicit slot", () => {
    const policy = createReplyToDeliveryPolicy({
      replyToId: "implicit-reply",
      replyToMode: "first",
    });
    const explicit = policy.resolveCurrentReplyTo({ replyToId: "explicit-reply" });
    const firstUnits = planOutboundTextMessageUnits({
      text: "explicit",
      overrides: { replyToId: explicit.replyToId, replyToIdSource: explicit.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });
    const implicit = policy.resolveCurrentReplyTo({});
    const secondUnits = planOutboundTextMessageUnits({
      text: "implicit",
      overrides: { replyToId: implicit.replyToId, replyToIdSource: implicit.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });

    expect(firstUnits[0]?.overrides.replyToId).toBe("explicit-reply");
    expect(secondUnits[0]?.overrides.replyToId).toBe("implicit-reply");
  });

  it("plans media sends with one implicit reply and a leading caption", () => {
    const policy = createReplyToDeliveryPolicy({
      replyToId: "reply-1",
      replyToMode: "batched",
    });
    const reply = policy.resolveCurrentReplyTo({});
    const units = planOutboundMediaMessageUnits({
      caption: "caption",
      mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
      overrides: { replyToId: reply.replyToId, replyToIdSource: reply.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });

    expect(
      units.map((unit) =>
        unit.kind === "media"
          ? [
              unit.kind,
              unit.caption,
              unit.mediaUrl,
              unit.overrides.replyToId,
              unit.overrides.deliveryPartIndex,
              unit.overrides.deliveryPartCount,
            ]
          : [unit.kind],
      ),
    ).toEqual([
      ["media", "caption", "https://example.com/1.png", "reply-1", 0, 2],
      ["media", undefined, "https://example.com/2.png", undefined, 1, 2],
    ]);
  });

  it("adds formatting overrides only to chunked text units", () => {
    const units = planOutboundTextMessageUnits({
      text: "**bold**",
      textLimit: 4000,
      chunker: () => ["<b>bold</b>"],
      chunkedTextFormatting: { parseMode: "HTML" },
      overrides: {},
    });

    expect(units).toEqual([
      {
        kind: "text",
        text: "<b>bold</b>",
        overrides: {
          formatting: { parseMode: "HTML" },
          deliveryPartIndex: 0,
          deliveryPartCount: 1,
        },
      },
    ]);
  });
});
