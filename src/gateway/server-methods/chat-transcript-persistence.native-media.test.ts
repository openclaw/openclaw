import { expect, it } from "vitest";
import { buildAssistantDisplayRewrite } from "./chat-transcript-persistence.js";

it.each([1, 4].flatMap((count) => [false, true].map((usage) => ({ count, usage }))))(
  "keeps only the native final caption ($count images, usage=$usage)",
  ({ count, usage }) => {
    const urls = Array.from({ length: count }, (_, i) => `/tmp/native-${i}.png`);
    const images = urls.map((url) => ({ type: "image" as const, source: { type: "url", url } }));
    const final = `Answer ready.\n${urls.map((url) => `MEDIA:${url}`).join("\n")}`;
    const message = {
      role: "assistant",
      content: [{ type: "text", text: final }],
      __openclaw: { externalId: "native-final" },
    };
    const footer = usage ? "custom usage footer" : undefined;
    const rewritten = buildAssistantDisplayRewrite({
      message,
      responseUsageLine: footer,
      displayContent: [
        {
          type: "text",
          text: `Checking files.\n\nRendering images.\n\n${final}${footer ? `\n${footer}` : ""}`,
        },
        ...images,
      ],
      mediaBySource: new Map(urls.map((url, i) => [url, [images[i]!]])),
      managedMediaUrls: urls,
    });
    expect(rewritten.openclawDisplayContent).toEqual([
      { type: "text", text: `Answer ready.${footer ? `\n${footer}` : ""}` },
      ...images,
    ]);
  },
);

it.each([
  {
    name: "fenced MEDIA examples",
    authored: "Answer ready.\n```\nMEDIA:/tmp/example.png\n```",
    footer: "custom usage footer",
  },
  {
    name: "an authored line equal to the usage footer",
    authored: "Answer ready.\ncustom usage footer",
    footer: "custom usage footer",
  },
])("keeps $name in the native final caption", ({ authored, footer }) => {
  const url = "/tmp/native-0.png";
  const image = { type: "image" as const, source: { type: "url", url } };
  const final = `${authored}\nMEDIA:${url}`;
  const rewritten = buildAssistantDisplayRewrite({
    message: {
      role: "assistant",
      content: [{ type: "text", text: final }],
      __openclaw: { externalId: "native-final" },
    },
    responseUsageLine: footer,
    displayContent: [{ type: "text", text: `Checking files.\n\n${final}\n${footer}` }, image],
    mediaBySource: new Map([[url, [image]]]),
    managedMediaUrls: [url],
  });
  expect(rewritten.openclawDisplayContent).toEqual([
    { type: "text", text: `${authored}\n${footer}` },
    image,
  ]);
});
