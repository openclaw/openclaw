import { expect, it } from "vitest";
import { chunkMarkdownText, chunkText } from "../../auto-reply/chunk.js";
import { planOutboundMediaMessageUnits, planOutboundTextMessageUnits } from "./message-plan.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";

type TextPlan = Parameters<typeof planOutboundTextMessageUnits>[0];
const expectedUnit = (text: string, overrides: TextPlan["overrides"], index = 0, count = 1) => ({
  text,
  overrides: { ...overrides, deliveryPartIndex: index, deliveryPartCount: count },
});
const planCase = (
  name: string,
  text: string,
  textLimit: number,
  expected: readonly string[],
  options: Partial<TextPlan> = {},
) => ({
  name,
  expected,
  params: {
    text,
    textLimit,
    chunker: chunkMarkdownText,
    chunkerMode: "markdown" as const,
    chunkMode: "length" as const,
    ...options,
  },
});
const replyPlan = (replyToMode: "first" | "batched" = "first") => {
  const policy = createReplyToDeliveryPolicy({ replyToId: "reply-1", replyToMode });
  const reply = policy.resolveCurrentReplyTo({});
  return {
    overrides: { replyToId: reply.replyToId, replyToIdSource: reply.source },
    consumeReplyTo: policy.applyReplyToConsumption,
  };
};
const fencedChunks = ["```txt\naa\nbb\n```", "```txt\ncc\n```"];

it.each([
  planCase("plain text", "aa bb cc dd", 6, ["aa bb", "cc dd"], {
    chunker: chunkText,
    chunkerMode: "text",
  }),
  planCase("unfenced Markdown", "aa bb\ncc dd\nee ff gg hh", 6, [
    "aa bb",
    "cc dd",
    "ee ff",
    "gg hh",
  ]),
  planCase("Markdown paragraphs", "first\n\nsecond", 6, ["first", "second"], {
    chunkMode: "newline",
  }),
  ...(["\u2028", "\u2029"] as const).flatMap((separator) =>
    (
      [
        ["fenced JSON", `\`\`\`json\n{"separator":"first${separator}second"}\n\`\`\``],
        ["inline code", `Copy \`first${separator}second\` exactly.`],
      ] as const
    ).flatMap(([codeName, text]) =>
      (["length", "newline"] as const).map((chunkMode) =>
        planCase(
          `${separator.charCodeAt(0).toString(16)} in ${codeName} in ${chunkMode} mode`,
          text,
          4000,
          [text],
          {
            chunkMode,
          },
        ),
      ),
    ),
  ),
  ...[0, -1].map((limit) =>
    planCase(
      `Markdown paragraphs with disabled limit ${limit}`,
      "```txt\ncontent\n```\n\nafter",
      limit,
      ["```txt\ncontent\n```\n\nafter"],
      { chunkMode: "newline" },
    ),
  ),
  planCase("fenced Markdown", "```txt\naa\nbb\ncc\n```", 16, fencedChunks),
  planCase(
    "long fenced paragraphs with a text-mode chunker",
    "intro\n\n```txt\naa\nbb\ncc\n```",
    16,
    ["intro", ...fencedChunks],
    { chunkerMode: "text", chunkMode: "newline" },
  ),
  ...([undefined, "newline"] as const).map((chunkMode) =>
    planCase(
      `${chunkMode ?? "default"} empty chunker fallback`,
      "visible reply",
      64,
      ["visible reply"],
      { chunkMode, chunkerMode: undefined, chunker: () => [] },
    ),
  ),
])("plans $name with one implicit reply", ({ params, expected }) => {
  expect(planOutboundTextMessageUnits({ ...params, ...replyPlan() })).toEqual(
    expected.map((text, index) =>
      expectedUnit(
        text,
        { replyToId: index === 0 ? "reply-1" : undefined, replyToIdSource: "implicit" },
        index,
        expected.length,
      ),
    ),
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
  expect(units).toEqual([expectedUnit("<b>bold</b>", { formatting: { parseMode: "HTML" } })]);
});
