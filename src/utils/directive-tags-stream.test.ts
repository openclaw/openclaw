import { describe, expect, test, vi } from "vitest";

const transformCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("./directive-tags-batch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./directive-tags-batch.js")>();
  return {
    ...actual,
    stripReplyTagsForDisplay: (text: string) => {
      transformCalls.count += 1;
      return actual.stripReplyTagsForDisplay(text);
    },
  };
});

import { createLiveAssistantTextProjection } from "../gateway/live-chat-projector.js";
import { createTextProjection } from "../shared/text/text-projection.js";
import { stripInlineDirectiveTagsForDisplay } from "./directive-tags-batch.js";
import { inlineDirectiveDisplayTextFilter } from "./directive-tags-stream.js";

function streamChunks(chunks: readonly string[]) {
  const projection = createTextProjection([inlineDirectiveDisplayTextFilter]);
  for (const chunk of chunks) {
    projection.append(chunk);
  }
  return projection;
}

function liveText(chunks: readonly string[]) {
  const projection = createLiveAssistantTextProjection({});
  return chunks.reduce((_text, chunk) => projection.append(chunk).text, "");
}

describe("inline directive display stream", () => {
  test.each([
    "[[reply_to_current]]\n\nHello world",
    "before [[reply_to:abc]] after",
    "See [[Architecture Notes]] for background.",
    "`[[reply_to_current]]` stays literal",
    "```text\n[[audio_as_voice]]\n```\nafter",
    "text [[audio_as_voice]] more",
    "One [[audio_as_voice\n\n]] after",
    "[[audio_as_voice]]```\n\nNext\n\n[[reply_to_current]] after\n",
    "[[reply_to:[[audio_as_voice]]id]]Visible",
    "unclosed [[reply_to_cur",
    "plain prose with `code` and ~~~ fences, no directives",
  ])("matches the canonical transform when streamed: %s", (source) => {
    const expected = stripInlineDirectiveTagsForDisplay(source).text;
    for (const size of [1, 2, 3, 4, 7, 64]) {
      const projection = createTextProjection([inlineDirectiveDisplayTextFilter]);
      for (let index = 0; index < source.length; index += size) {
        projection.append(source.slice(index, index + size));
      }
      expect(projection.text).toBe(expected);
    }
  });

  test("strips a directive whose marker and close arrive in later deltas", () => {
    expect(streamChunks(["Text [[reply_to_cur", "rent]] done"]).text).toBe("Text  done");
    expect(streamChunks(["[[reply_", "to_current]]", "\n\nHello", " world"]).text).toBe(
      "\n\nHello world",
    );
  });

  test("keeps directives inside code literal while prose keeps appending", () => {
    const projection = streamChunks([
      "```text\n",
      "[[audio_as_voice]]\n",
      "```\n",
      "after [[reply_to_current]] done",
      " and more",
    ]);
    expect(projection.text).toBe("```text\n[[audio_as_voice]]\n```\nafter  done and more");
  });

  test("keeps the visible baseline across identity appends and empty updates", () => {
    const projection = createLiveAssistantTextProjection({});
    expect(projection.append("Hello").text).toBe("Hello");
    expect(projection.append("").text).toBe("Hello");
    const filtered = createTextProjection([inlineDirectiveDisplayTextFilter]);
    filtered.append("Hello");
    expect(filtered.append("").text).toBe("Hello");
  });

  test("re-parses when a resolved image turns protected inline code into alt text", () => {
    const source = "![`[[reply_to_current]]`](/image.png)";
    const expected = stripInlineDirectiveTagsForDisplay(source).text;
    expect(expected).not.toBe(source);
    for (const chunks of [
      ["![`[[reply_to_current]]`", "](/image.png)"],
      ["![", "`", "[[reply_to_current]]", "`", "](/image.png)"],
      Array.from({ length: source.length }, (_, index) => source.charAt(index)),
    ]) {
      expect(liveText(chunks)).toBe(expected);
    }
  });

  test("retains parsing when a plain character invalidates a table delimiter", () => {
    const chunks = ["`\n[[reply_to_current]]\n` |\n---|", "x"];
    const source = chunks.join("");
    const expected = stripInlineDirectiveTagsForDisplay(source).text;
    expect(expected).toBe(source);
    expect(liveText(chunks)).toBe(expected);
  });

  test("retains parsing when audio removal changes the image description", () => {
    const chunks = ["![[audio_as_voice]][`[[reply_to_current]]` example", "](/image.png)"];
    const source = chunks.join("");
    const expected = stripInlineDirectiveTagsForDisplay(source).text;
    expect(expected).not.toBe(source);
    for (const chunkSize of [1, 2, 4, source.length]) {
      const sized = Array.from({ length: Math.ceil(source.length / chunkSize) }, (_, index) =>
        source.slice(index * chunkSize, (index + 1) * chunkSize),
      );
      expect(liveText(sized)).toBe(expected);
    }
    const projection = createTextProjection([inlineDirectiveDisplayTextFilter]);
    projection.append(chunks[0]!);
    expect(projection.append(chunks[1]!).text).toBe(expected);
  });

  test("keeps deltas correct when a later chunk first strips a directive", () => {
    const projection = createTextProjection([inlineDirectiveDisplayTextFilter]);
    projection.append("Hello");
    projection.append(" [[reply_to_current]]");
    const result = projection.append(" world");
    expect(projection.text).toBe("Hello  world");
    expect(result.delta).toBe(" world");
  });

  test("emits only the appended suffix once the directive is settled", () => {
    const projection = streamChunks(["[[reply_to_current]]", "\n\nHello", " world"]);
    expect(projection.append("!").delta).toBe("!");
  });

  test("does not re-parse the whole reply after a settled prose directive", () => {
    const body = Array.from(
      { length: 400 },
      (_, index) =>
        `Paragraph ${index + 1} keeps ordinary prose streaming with enough words to wrap the line.\n\n`,
    ).join("");
    const source = `[[reply_to_current]]\n\n${body}`;
    expect(source.length).toBeGreaterThan(30_000);
    transformCalls.count = 0;
    const projection = createTextProjection([inlineDirectiveDisplayTextFilter]);
    for (let offset = 0; offset < source.length; offset += 4) {
      projection.append(source.slice(offset, offset + 4));
    }
    expect(projection.text).toBe(`\n\n${body}`);
    // The fixed owner transforms the directive while its syntax is open, then extends.
    expect(transformCalls.count).toBeLessThan(64);
  });
});

test("bounds directive parsing through the real live-chat projection", () => {
  const body = Array.from(
    { length: 400 },
    (_, index) => `Paragraph ${index + 1} keeps ordinary prose streaming on the live path.\n\n`,
  ).join("");
  const source = `See [[Architecture Notes]] for background.\n\n${body}`;
  transformCalls.count = 0;
  const projection = createLiveAssistantTextProjection({});
  let text = "";
  for (let offset = 0; offset < source.length; offset += 4) {
    text = projection.append(source.slice(offset, offset + 4)).text;
  }
  expect(text).toBe(stripInlineDirectiveTagsForDisplay(source).text);
  expect(transformCalls.count).toBeLessThan(64);
});
