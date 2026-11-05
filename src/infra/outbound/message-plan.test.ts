import { expect, it } from "vitest";
import { chunkMarkdownText, chunkText } from "../../auto-reply/chunk.js";
import { planOutboundMediaMessageUnits, planOutboundTextMessageUnits } from "./message-plan.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";

type TextPlan = Parameters<typeof planOutboundTextMessageUnits>[0];
const replyPlan = (replyToMode: "first" | "batched" = "first") => {
  const policy = createReplyToDeliveryPolicy({ replyToId: "reply-1", replyToMode });
  const reply = policy.resolveCurrentReplyTo({});
  return {
    overrides: { replyToId: reply.replyToId, replyToIdSource: reply.source },
    consumeReplyTo: policy.applyReplyToConsumption,
  };
};
const fencedChunks = ["```txt\naa\nbb\n```", "```txt\ncc\n```"];
const fence = "```txt\naa\nbb\ncc\n```";
const unicodeCode = '```json\n{"text":"a\u2028b\u2029c"}\n```\nCopy `a\u2028b\u2029c` exactly.';
type PlanCase = { text: string; expected: string[]; options: Partial<TextPlan> };

it.each`
  name                       | text                           | expected                                | options
  ${"plain text"}            | ${"aa bb cc dd"}               | ${["aa bb", "cc dd"]}                   | ${{ chunker: chunkText, chunkerMode: "text" }}
  ${"unfenced Markdown"}     | ${"aa bb\ncc dd\nee ff gg hh"} | ${["aa bb", "cc dd", "ee ff", "gg hh"]} | ${{}}
  ${"Markdown paragraphs"}   | ${"first\n\nsecond"}           | ${["first", "second"]}                  | ${{ chunkMode: "newline" }}
  ${"Unicode length"}        | ${unicodeCode}                 | ${[unicodeCode]}                        | ${{ textLimit: 4000 }}
  ${"Unicode newline"}       | ${unicodeCode}                 | ${[unicodeCode]}                        | ${{ textLimit: 4000, chunkMode: "newline" }}
  ${"disabled limit"}        | ${`${fence}\n\nafter`}         | ${[`${fence}\n\nafter`]}                | ${{ textLimit: 0, chunkMode: "newline" }}
  ${"fenced Markdown"}       | ${fence}                       | ${fencedChunks}                         | ${{ textLimit: 16 }}
  ${"text-mode paragraphs"}  | ${`intro\n\n${fence}`}         | ${["intro", ...fencedChunks]}           | ${{ textLimit: 16, chunkerMode: "text", chunkMode: "newline" }}
  ${"empty chunker length"}  | ${"reply"}                     | ${["reply"]}                            | ${{ chunkerMode: undefined, chunker: () => [] }}
  ${"empty chunker newline"} | ${"reply"}                     | ${["reply"]}                            | ${{ chunkMode: "newline", chunkerMode: undefined, chunker: () => [] }}
`("plans $name with one implicit reply", ({ text, expected, options }: PlanCase) => {
  expect(
    planOutboundTextMessageUnits({
      text,
      textLimit: 6,
      chunker: chunkMarkdownText,
      chunkerMode: "markdown",
      chunkMode: "length",
      ...options,
      ...replyPlan(),
    }),
  ).toEqual(
    expected.map((chunk, index) => ({
      text: chunk,
      overrides: {
        replyToId: index === 0 ? "reply-1" : undefined,
        replyToIdSource: "implicit",
        deliveryPartIndex: index,
        deliveryPartCount: expected.length,
      },
    })),
  );
});

it("keeps explicit text replies from consuming the implicit slot", () => {
  const policy = createReplyToDeliveryPolicy({ replyToId: "implicit", replyToMode: "first" });
  const planReply = (text: string, replyToId?: string) => {
    const reply = policy.resolveCurrentReplyTo({ replyToId });
    return planOutboundTextMessageUnits({
      text,
      overrides: { replyToId: reply.replyToId, replyToIdSource: reply.source },
      consumeReplyTo: policy.applyReplyToConsumption,
    })[0]?.overrides.replyToId;
  };
  expect([planReply("explicit", "explicit-reply"), planReply("implicit")]).toEqual([
    "explicit-reply",
    "implicit",
  ]);
});

it("plans media sends with one implicit reply and a leading caption", () => {
  const units = planOutboundMediaMessageUnits({
    caption: "caption",
    mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
    ...replyPlan("batched"),
  });

  expect(
    units.map(({ caption, mediaUrl, overrides }) => [
      caption,
      mediaUrl,
      overrides.replyToId,
      overrides.deliveryPartIndex,
      overrides.deliveryPartCount,
    ]),
  ).toEqual([
    ["caption", "https://example.com/1.png", "reply-1", 0, 2],
    [undefined, "https://example.com/2.png", undefined, 1, 2],
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
      text: "<b>bold</b>",
      overrides: {
        formatting: { parseMode: "HTML" },
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      },
    },
  ]);
});
