import { describe, expect, it } from "vitest";

import { chunkDiscordText } from "./chunk.js";

function countLines(text: string) {
  return text.split("\n").length;
}

function hasBalancedFences(chunk: string) {
  let open = false;
  for (const line of chunk.split("\n")) {
    if (line.trim().startsWith("```")) open = !open;
  }
  return open === false;
}

describe("chunkDiscordText", () => {
  it("splits tall messages even when under 2000 chars", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    expect(text.length).toBeLessThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countLines(chunk)).toBeLessThanOrEqual(20);
    }
  });

  it("keeps fenced code blocks balanced across chunks", () => {
    const body = Array.from(
      { length: 30 },
      (_, i) => `console.log(${i});`,
    ).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }

    expect(chunks[0]).toContain("```js");
    expect(chunks.at(-1)).toContain("Done.");
  });
});
