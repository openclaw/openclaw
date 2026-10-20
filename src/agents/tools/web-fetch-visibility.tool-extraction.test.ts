import type { Server } from "node:http";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebFetchTool } from "./web-fetch.js";

const MARKDOWN_CODE =
  '# Example\n\n- Read [the guide](https://example.com).\n\n```text\n# comment\n- literal\n1. literal\n[label](https://example.com)\n![alt](image.png)\n`value`\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True\n```';

const MARKDOWN_PAGES: Record<string, string> = {
  "/markdown-code": MARKDOWN_CODE,
  "/markdown-unclosed":
    '```text\n# literal\n- literal\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True',
  "/markdown-inline-fence-prose": "Use ``` to start a code block.\nNext paragraph.",
};

const PAGES: Record<string, string> = {
  ...MARKDOWN_PAGES,
  "/implicit-nested-siblings":
    "<ul><li hidden><ul><li>A<li>B</li></ul>Secret</li></ul><p>Visible</p>",
  "/unmatched-container": "<p hidden>Before</div>Secret</p><p>Visible</p>",
  "/framework-attrs": [
    "<html><head><title>Framework Attributes</title></head><body>",
    "<p>Pricing starts at nine dollars.</p>",
    '<div @click="noop" hidden>Secret framework note</div>',
    '<div (click)="noop" class="hidden">Secret class note</div>',
    "<p>Support is available around the clock.</p>",
    "</body></html>",
  ].join(""),
};

async function startPageServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const page = PAGES[req.url ?? ""];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": `${Object.hasOwn(MARKDOWN_PAGES, req.url ?? "") ? "text/markdown" : "text/html"}; charset=utf-8`,
    });
    res.end(page);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a loopback TCP address for the page server");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("web_fetch visibility through the real tool execute path", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startPageServer());
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function extract(
    path: string,
    extractMode: "markdown" | "text" = "markdown",
  ): Promise<string> {
    const fetch = { cacheTtlMinutes: 0, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } };
    const tool = createWebFetchTool({
      config: {
        // Force basic extraction through the real tool, without plugin extractors.
        plugins: { enabled: false },
        tools: { web: { fetch } },
      },
    });
    if (!tool) {
      throw new Error("expected enabled web_fetch tool");
    }
    const result = await tool.execute("call", { url: `${baseUrl}${path}`, extractMode });
    return result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  async function extractMarkdown(path: string, mode: "markdown" | "text") {
    const result = JSON.parse(await extract(path, mode)) as { extractor: string; text: string };
    expect(result.extractor).toBe("cf-markdown");
    return result.text;
  }

  it.each(["/implicit-nested-siblings", "/unmatched-container"])(
    "keeps hidden owners across %s",
    async (path) => {
      const text = await extract(path);
      expect(text).toContain("Visible");
      expect(text).not.toContain("Secret");
    },
  );

  it("keeps visible content and drops hidden content after framework attributes", async () => {
    const text = await extract("/framework-attrs");
    expect(text).toContain("Pricing starts at nine dollars.");
    expect(text).toContain("Support is available around the clock.");
    expect(text).not.toContain("Secret framework note");
    expect(text).not.toContain("Secret class note");
  });

  it.each(["text", "markdown"] as const)(
    "preserves code examples through HTTP Markdown extraction in %s mode",
    async (mode) => {
      expect(await extractMarkdown("/markdown-code", mode)).toContain(
        mode === "markdown"
          ? MARKDOWN_CODE
          : 'Example\n\nRead the guide.\n\n# comment\n- literal\n1. literal\n[label](https://example.com)\n![alt](image.png)\n`value`\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True',
      );
    },
  );

  it.each([
    [
      "/markdown-unclosed",
      '# literal\n- literal\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True',
    ],
    ["/markdown-inline-fence-prose", "Use ``` to start a code block.\nNext paragraph."],
  ])("preserves Markdown content through HTTP text extraction for %s", async (path, expected) => {
    expect(await extractMarkdown(path, "text")).toContain(expected);
  });
});
