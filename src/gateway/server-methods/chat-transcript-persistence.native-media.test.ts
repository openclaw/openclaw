import { expect, it } from "vitest";
import { buildAssistantDisplayRewrite } from "./chat-transcript-persistence.js";

const footer = "custom usage footer";
const cases = [1, 4].flatMap((count) =>
  [undefined, footer].map((usage) => ({ count, usage, authored: "Answer ready." })),
);
cases.push(
  { count: 1, usage: footer, authored: "Answer ready.\n```\nMEDIA:/tmp/example.png\n```" },
  { count: 1, usage: footer, authored: `Answer ready.\n${footer}` },
);
it.each(cases)(
  "keeps the native caption ($count images, usage=$usage, authored=$authored)",
  ({ count, usage, authored }) => {
    const urls = Array.from({ length: count }, (_, i) => `/tmp/native-${i}.png`);
    const images = urls.map((url) => ({ type: "image" as const, source: { type: "url", url } }));
    const final = `${authored}\n${urls.map((url) => `MEDIA:${url}`).join("\n")}`;
    const rewritten = buildAssistantDisplayRewrite({
      message: {
        role: "assistant",
        content: [{ type: "text", text: final }],
        __openclaw: { externalId: "native-final" },
      },
      responseUsageLine: usage,
      displayContent: [
        {
          type: "text",
          text: `Checking files.\n\nRendering images.\n\n${final}${usage ? `\n${usage}` : ""}`,
        },
        ...images,
      ],
      mediaBySource: new Map(urls.map((url, i) => [url, [images[i]!]])),
      managedMediaUrls: urls,
    });
    expect(rewritten.openclawDisplayContent).toEqual([
      { type: "text", text: `${authored}${usage ? `\n${usage}` : ""}` },
      ...images,
    ]);
  },
);
