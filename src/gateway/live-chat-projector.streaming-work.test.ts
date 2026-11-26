import { beforeEach, expect, it, vi } from "vitest";

const parserWork = vi.hoisted(() => ({
  directives: { calls: 0, characters: 0 },
  media: { calls: 0, characters: 0 },
  runtime: { calls: 0, characters: 0 },
}));

vi.mock("../utils/directive-tags-batch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/directive-tags-batch.js")>();
  return {
    ...actual,
    stripInlineDirectiveTagsForDisplay: (text: string) => {
      parserWork.directives.calls += 1;
      parserWork.directives.characters += text.length;
      return actual.stripInlineDirectiveTagsForDisplay(text);
    },
  };
});

vi.mock("../agents/internal-runtime-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/internal-runtime-context.js")>();
  return {
    ...actual,
    stripInternalRuntimeContext: (
      text: string,
      options?: Parameters<typeof actual.stripInternalRuntimeContext>[1],
    ) => {
      parserWork.runtime.calls += 1;
      parserWork.runtime.characters += text.length;
      return actual.stripInternalRuntimeContext(text, options);
    },
  };
});

vi.mock("./chat-display-projection.helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-display-projection.helpers.js")>();
  return {
    ...actual,
    stripAssistantMediaDirectivesForDisplay: (
      text: string,
      managedMediaUrls: readonly string[],
    ) => {
      parserWork.media.calls += 1;
      parserWork.media.characters += text.length;
      return actual.stripAssistantMediaDirectivesForDisplay(text, managedMediaUrls);
    },
  };
});

import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX,
  stripInternalRuntimeContext,
} from "../agents/internal-runtime-context.js";
import { RUNTIME_CONTEXT_FOOTER, RUNTIME_CONTEXT_HEADER } from "../llm/types.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags-batch.js";
import { stripAssistantMediaDirectivesForDisplay } from "./chat-display-projection.helpers.js";
import {
  createLiveAssistantTextProjection,
  normalizeLiveAssistantBufferedText,
} from "./live-chat-projector.js";
import { createChatRunState } from "./server-chat-state.js";

const body = Array.from(
  { length: 190 },
  (_, index) => `Paragraph ${index + 1} keeps ordinary prose streaming after the directive.\n\n`,
).join("");
const markdownBody = Array.from(
  { length: 190 },
  (_, index) =>
    `Paragraph ${index + 1} keeps \`inline code\` and [links](https://example.test/${index}) streaming.\n\n`,
).join("");

function resetParserWork() {
  for (const work of Object.values(parserWork)) {
    work.calls = 0;
    work.characters = 0;
  }
}

beforeEach(() => {
  resetParserWork();
});

function stream(source: string, options?: { managedMediaUrls?: readonly string[] }, chunkSize = 4) {
  const projection = createLiveAssistantTextProjection(options);
  let result = { text: "", suppress: true, delta: null as string | null };
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    result = projection.append(source.slice(offset, offset + chunkSize));
  }
  return result;
}

function expectPrefixParity(
  source: string,
  options?: { managedMediaUrls?: readonly string[] },
  chunkSizes: readonly number[] = [1, 4, 17],
) {
  for (const chunkSize of chunkSizes) {
    const projection = createLiveAssistantTextProjection(options);
    let previousEnd = 0;
    for (let end = chunkSize; end <= source.length + chunkSize - 1; end += chunkSize) {
      const length = Math.min(end, source.length);
      const result = projection.append(source.slice(previousEnd, length));
      previousEnd = length;
      expect(result.text, `chunk size ${chunkSize}, prefix ${length}`).toBe(
        normalizeLiveAssistantBufferedText(source.slice(0, length), {
          ...options,
          streaming: true,
        }),
      );
    }
  }
}

it.each([
  {
    name: "settled audio with inline code and a link title",
    source:
      '[[audio_as_voice]]\n\nIntro with `code` and [label](https://example.com "title").\n\nTail',
  },
  {
    name: "audio activated after Markdown has started",
    source: "Intro with `code`\n\n[[audio_as_voice]]\n\n![alt](image.png)\n\nDone",
  },
  {
    name: "managed media with non-monotonic trailing whitespace",
    source: "Intro.\n\nMEDIA:chart.png\n\n\nNext",
    managedMediaUrls: ["chart.png"],
  },
  {
    name: "managed media across CRLF",
    source: "Intro\r\nMEDIA:chart.png\r\n\r\nNext",
    managedMediaUrls: ["chart.png"],
  },
  {
    name: "unmanaged absolute media after managed media has activated",
    source: "Intro\nMEDIA:chart.png\nDone\nMEDIA:/tmp/a.png",
    managedMediaUrls: ["chart.png"],
  },
  {
    name: "managed media followed by Markdown links and inline code",
    source: `Intro.\n\nMEDIA:chart.png\n\n${markdownBody.slice(0, 2_000)}`,
    managedMediaUrls: ["chart.png"],
  },
  {
    name: "completed protected runtime context",
    source: `Before.\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nsecret\n${INTERNAL_RUNTIME_CONTEXT_END}\nAfter.`,
  },
  {
    name: "unterminated protected runtime context",
    source: `Visible.\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nsecret\ncontinued`,
  },
  {
    name: "current runtime context carrier",
    source: `${RUNTIME_CONTEXT_HEADER}\nsecret\n${RUNTIME_CONTEXT_FOOTER}\n\nVisible.`,
  },
  {
    name: "legacy internal event context",
    source: `${INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX}\nsecret event body\n\nVisible.`,
  },
  {
    name: "multiple current runtime context carriers",
    source: `First\n\n${RUNTIME_CONTEXT_HEADER}\nsecret one\n${RUNTIME_CONTEXT_FOOTER}\n\nMiddle\n\n${RUNTIME_CONTEXT_HEADER}\nsecret two\n${RUNTIME_CONTEXT_FOOTER}\n\nLast`,
  },
  {
    name: "whitespace-tolerant runtime notice",
    source:
      "OpenClaw runtime event.\nThis context is runtime-generated, not user-authored. Keep internal details private.\n\nVisible reply.",
  },
  {
    name: "ordinary current-context phrase",
    source: "The phrase OpenClaw runtime context: is ordinary text.",
  },
  {
    name: "inline protected delimiter mention",
    source: `The marker ${INTERNAL_RUNTIME_CONTEXT_BEGIN} is ordinary text. ${body.slice(0, 160)}`,
  },
] as const)("matches the canonical live projection for $name", ({ source, managedMediaUrls }) => {
  const expected = normalizeLiveAssistantBufferedText(source, {
    managedMediaUrls,
  });
  for (const chunkSize of [1, 4, 17, source.length]) {
    expect(stream(source, { managedMediaUrls }, chunkSize).text, `chunk size ${chunkSize}`).toBe(
      expected,
    );
  }
});

it("matches the canonical live projection when a private block arrives in one delta", () => {
  const source = `Before.\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nsecret\n${INTERNAL_RUNTIME_CONTEXT_END}\nAfter.`;
  const expected = normalizeLiveAssistantBufferedText(source);
  expect(stream(source, undefined, source.length).text).toBe(expected);
});

it.each([
  {
    name: "audio directive and Markdown",
    source: 'Intro `code` and [link](https://example.test "title")\n\n[[audio_as_voice]]\n\nDone',
  },
  {
    name: "managed media and trailing blank lines",
    source: "Intro.\r\nMEDIA:chart.png\r\n\r\nNext",
    managedMediaUrls: ["chart.png"],
  },
  {
    name: "completed runtime context",
    source: `Before.\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nsecret\n${INTERNAL_RUNTIME_CONTEXT_END}\nAfter.`,
  },
] as const)("matches the canonical live projection at every prefix for $name", (testCase) => {
  expectPrefixParity(testCase.source, { managedMediaUrls: testCase.managedMediaUrls });
});

it("bounds all directive stages through the Gateway chat state entry point", () => {
  const source = [
    "[[audio_as_voice]]",
    "",
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "private runtime context",
    INTERNAL_RUNTIME_CONTEXT_END,
    "",
    "Intro.",
    "MEDIA:chart.png",
    "",
    body,
  ].join("\n");
  const managedMediaUrls = ["chart.png"];
  const expected = normalizeLiveAssistantBufferedText(source, { managedMediaUrls });
  resetParserWork();

  const state = createChatRunState();
  for (let offset = 0; offset < source.length; offset += 4) {
    state.updateBuffer("reply", { delta: source.slice(offset, offset + 4), managedMediaUrls });
    state.resolveBuffer("reply");
  }

  expect(state.resolveBuffer("reply").text).toBe(expected);
  for (const work of Object.values(parserWork)) {
    expect(work.calls).toBeLessThanOrEqual(64);
    expect(work.characters).toBeLessThanOrEqual(source.length * 2);
  }
});

it("bounds directive parsing after a settled audio directive", () => {
  const source = `[[audio_as_voice]]\n\n${markdownBody}`;
  const expected = stripInlineDirectiveTagsForDisplay(source).text;
  resetParserWork();

  const result = stream(source);

  expect(result.text).toBe(expected);
  expect(parserWork.directives.calls).toBeLessThanOrEqual(64);
  expect(parserWork.directives.characters).toBeLessThanOrEqual(source.length * 2);
});

it("bounds runtime-context scrubbing after a completed private block", () => {
  const source = [
    "Before.",
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "private runtime context",
    INTERNAL_RUNTIME_CONTEXT_END,
    "",
    body,
  ].join("\n");
  const expected = stripInternalRuntimeContext(source);
  resetParserWork();

  const result = stream(source);

  expect(result.text).toBe(expected);
  expect(parserWork.runtime.calls).toBeLessThanOrEqual(64);
  expect(parserWork.runtime.characters).toBeLessThanOrEqual(source.length * 2);
});

it("bounds legacy event scrubbing after its complete prefix", () => {
  const source = [
    INTERNAL_RUNTIME_CONTEXT_EVENT_PREFIX,
    "private event body ".repeat(1_500),
    "",
    "Visible.",
  ].join("\n");
  const expected = stripInternalRuntimeContext(source);
  resetParserWork();

  const result = stream(source);

  expect(result.text).toBe(expected);
  expect(parserWork.runtime.calls).toBeLessThanOrEqual(32);
  expect(parserWork.runtime.characters).toBeLessThanOrEqual(source.length * 3);
});

it("bounds managed-media parsing after a completed directive line", () => {
  const source = `Intro.\n\nMEDIA:chart.png\n\n${markdownBody}`;
  const managedMediaUrls = ["chart.png"];
  const expected = stripAssistantMediaDirectivesForDisplay(source, managedMediaUrls);
  resetParserWork();

  const result = stream(source, { managedMediaUrls });

  expect(result.text).toBe(expected);
  expect(parserWork.media.calls).toBeLessThanOrEqual(64);
  expect(parserWork.media.characters).toBeLessThanOrEqual(source.length * 2);
});
