import { expect, it } from "vitest";
import { buildAssistantDisplayRewrite } from "./chat-transcript-persistence.js";

it.each([1, 4])("keeps only the native final caption with %i images", (count) => {
  const urls = Array.from({ length: count }, (_, i) => `/tmp/native-${i}.png`);
  const images = urls.map((url) => ({ type: "image" as const, source: { type: "url", url } }));
  const final = `Answer ready.\n${urls.map((url) => `MEDIA:${url}`).join("\n")}`;
  const message = {
    role: "assistant",
    content: [{ type: "text", text: final }],
    __openclaw: { externalId: "native-final" },
  };
  const rewritten = buildAssistantDisplayRewrite({
    message,
    displayContent: [
      { type: "text", text: `Checking files.\n\nRendering images.\n\n${final}` },
      ...images,
    ],
    mediaBySource: new Map(urls.map((url, i) => [url, [images[i]!]])),
    managedMediaUrls: urls,
  });
  expect(rewritten.openclawDisplayContent).toEqual([
    { type: "text", text: "Answer ready." },
    ...images,
  ]);
});
