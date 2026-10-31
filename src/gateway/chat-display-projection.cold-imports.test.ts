import "../test-utils/prepare-compiled-subprocesses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { markdownParserPath, markdownTokenizerPath } = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(
    new URL("../../packages/markdown-core/package.json", import.meta.url),
  );
  const parserPath = require.resolve("mdast-util-from-markdown");
  return {
    markdownParserPath: parserPath,
    markdownTokenizerPath: createRequire(parserPath).resolve("micromark"),
  };
});

// mock-isolation: Rich-source readers may load these exports, but display must never parse a tree.
vi.mock(markdownParserPath, async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fromMarkdown() {
    throw new Error("Display projection must not parse a full Markdown tree");
  },
}));
vi.mock(markdownTokenizerPath, async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parse() {
    throw new Error("Display projection must not tokenize full Markdown");
  },
}));

vi.mock("../../packages/markdown-core/src/image-spans.js", () => {
  throw new Error("Display projection must not load the Markdown image scanner");
});

// mock-isolation: Throw on import to prove display never initializes provider stream parsing.
vi.mock("../../packages/ai/src/transports/transport-stream-shared.js", () => {
  throw new Error("Display projection must not load provider stream parsing");
});

const visibleText = [
  "Visible reply",
  "![chart](https://example.test/chart.png)",
  "```text",
  "MEDIA:./example.png",
  "```",
].join("\n");
const text = `${visibleText}\nMEDIA:./managed.png`;

describe("display media without Markdown image scanning", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("projects history media while preserving Markdown images and fenced directives", async () => {
    const { projectChatDisplayMessages } = await import("./chat-display-projection.js");

    expect(
      projectChatDisplayMessages([
        {
          role: "assistant",
          content: text,
          openclawDelivery: { mediaUrls: ["./managed.png"] },
        },
      ]),
    ).toMatchObject([{ content: visibleText }]);
  });

  it("withholds a live relative media tail without consuming Markdown images", async () => {
    const { normalizeLiveAssistantBufferedText } = await import("./live-chat-projector.js");

    expect(normalizeLiveAssistantBufferedText(text)).toBe(`${visibleText}\n`);
  });

  it("sanitizes assistant controls while preserving quoted code without full Markdown parsing", async () => {
    const { sanitizeAssistantVisibleTextWithProfile } =
      await import("../shared/text/assistant-visible-text.js");
    const { stripInlineDirectiveTagsForDisplay } = await import("../utils/directive-tags-batch.js");
    const literal = "> ~~~text\n> <think>literal</think>\n> [[reply_to_current]]\n> ~~~";
    const source =
      "[Tool Call: read]\nArguments: {}\n<think>private</think>Visible\n\n" +
      literal +
      "\n\n[[reply_to_current]]";
    const sanitized = sanitizeAssistantVisibleTextWithProfile(source, "history");
    expect(sanitized).toBe(`Visible\n\n${literal}\n\n[[reply_to_current]]`);
    expect(stripInlineDirectiveTagsForDisplay(sanitized)).toEqual({
      text: `Visible\n\n${literal}\n\n`,
      changed: true,
    });
  });

  it("renders public text with its own Markdown renderer after stripping media directives", async () => {
    const { renderPublicSessionDocument } = await import("./control-ui-public-session-render.js");

    const html = renderPublicSessionDocument({
      messages: [{ role: "assistant", content: text }],
      title: "Shared conversation",
      truncated: false,
      latestUrl: "/share/session?token=synthetic",
      cardUrl: "https://example.test/share/card.png",
      assetBasePath: "",
    });
    expect(html).toContain("Visible reply");
    expect(html).toContain("[Image omitted]");
    expect(html).toContain("MEDIA:./example.png");
    expect(html).not.toContain("managed.png");
  });
});
