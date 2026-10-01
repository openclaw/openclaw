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

  it("preserves fenced blocks for newline chunk mode so the adapter can balance fences", () => {
    const text = ```ts
const value1 = compute(1);\nconst value2 = compute(2);\nconst value3 = compute(3);\nconst value4 = compute(4);\nconst value5 = compute(5);\nconst value6 = compute(6);\nconst value7 = compute(7);\nconst value8 = compute(8);\nconst value9 = compute(9);\nconst value10 = compute(10);\nconst value11 = compute(11);\nconst value12 = compute(12);\nconst value13 = compute(13);\nconst value14 = compute(14);\nconst value15 = compute(15);\nconst value16 = compute(16);\nconst value17 = compute(17);\nconst value18 = compute(18);\nconst value19 = compute(19);\nconst value20 = compute(20);\nconst value21 = compute(21);\nconst value22 = compute(22);\nconst value23 = compute(23);\nconst value24 = compute(24);\nconst value25 = compute(25);\nconst value26 = compute(26);\nconst value27 = compute(27);\nconst value28 = compute(28);\nconst value29 = compute(29);\nconst value30 = compute(30);\nconst value31 = compute(31);\nconst value32 = compute(32);\nconst value33 = compute(33);\nconst value34 = compute(34);\nconst value35 = compute(35);\nconst value36 = compute(36);\nconst value37 = compute(37);\nconst value38 = compute(38);\nconst value39 = compute(39);\nconst value40 = compute(40);\nconst value41 = compute(41);\nconst value42 = compute(42);\nconst value43 = compute(43);\nconst value44 = compute(44);\nconst value45 = compute(45);\nconst value46 = compute(46);\nconst value47 = compute(47);\nconst value48 = compute(48);\nconst value49 = compute(49);\nconst value50 = compute(50);\nconst value51 = compute(51);\nconst value52 = compute(52);\nconst value53 = compute(53);\nconst value54 = compute(54);\nconst value55 = compute(55);\nconst value56 = compute(56);\nconst value57 = compute(57);\nconst value58 = compute(58);\nconst value59 = compute(59);\nconst value60 = compute(60);
```;
    const units = planOutboundTextMessageUnits({
      text,
      textLimit: 2000,
      chunker: (value) => [value],
      chunkMode: "newline",
      overrides: {},
    });

    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe(text);
  });

  it.each([
    { label: "default", chunkMode: undefined },
    { label: "length", chunkMode: "length" as const },
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
