import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import { createWebFetchTool } from "./web-fetch.js";

const MARKDOWN_CODE =
  '# Example\n\n- Read [the guide](https://example.com).\n\n```text\n# comment\n- literal\n1. literal\n[label](https://example.com)\n![alt](image.png)\n`value`\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True\n```';
const UNCLOSED_CODE =
  '# literal\n- literal\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True';
const INLINE_FENCE = "Use ``` to start a code block.\nNext paragraph.";
const PAGES: Record<string, string> = {
  "/markdown-code": MARKDOWN_CODE,
  "/markdown-unclosed": `\`\`\`text\n${UNCLOSED_CODE}`,
  "/markdown-inline-fence-prose": INLINE_FENCE,
  "/implicit-nested-siblings":
    "<ul><li hidden><ul><li>A<li>B</li></ul>Secret</li></ul><p>Visible</p>",
  "/unmatched-container": "<p hidden>Before</div>Secret</p><p>Visible</p>",
  "/framework-attrs": [
    "<html><head><title>Framework Attributes</title></head><body>",
    "<p>Pricing starts at nine dollars.</p>",
    '<div @click="noop" hidden>Secret framework note</div>',
    '<div (click)="noop" class="hidden">Secret class note</div>',
    "<p>Support is available around the clock.</p></body></html>",
  ].join(""),
};

describe("web_fetch visibility through the real tool execute path", () => {
  let baseUrl: string;
  const server = createServer((req, res) => {
    const page = PAGES[req.url ?? ""];
    res.writeHead(page ? 200 : 404, {
      "content-type": `${req.url?.startsWith("/markdown-") ? "text/markdown" : "text/html"}; charset=utf-8`,
    });
    res.end(page ?? "not found");
  });
  beforeAll(async () => {
    baseUrl = await listenLoopback(server);
  });
  afterAll(() => closeHttpServer(server));

  it.each([
    { path: "/implicit-nested-siblings", includes: ["Visible"], excludes: ["Secret"] },
    { path: "/unmatched-container", includes: ["Visible"], excludes: ["Secret"] },
    {
      path: "/framework-attrs",
      includes: ["Pricing starts at nine dollars.", "Support is available around the clock."],
      excludes: ["Secret framework note", "Secret class note"],
    },
  ])(
    "preserves visible content and hidden owners in $path",
    async ({ path, includes, excludes }) => {
      const text = await extract(path);
      for (const visible of includes) {
        expect(text).toContain(visible);
      }
      for (const hidden of excludes) {
        expect(text).not.toContain(hidden);
      }
    },
  );

  it.each([
    { path: "/markdown-code", mode: "markdown", expected: MARKDOWN_CODE },
    {
      path: "/markdown-code",
      mode: "text",
      expected:
        'Example\n\nRead the guide.\n\n# comment\n- literal\n1. literal\n[label](https://example.com)\n![alt](image.png)\n`value`\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True',
    },
    { path: "/markdown-unclosed", mode: "text", expected: UNCLOSED_CODE },
    { path: "/markdown-inline-fence-prose", mode: "text", expected: INLINE_FENCE },
  ] as const)("preserves $path in $mode mode", async ({ path, mode, expected }) => {
    const result = JSON.parse(await extract(path, mode)) as { extractor: string; text: string };
    expect(result).toMatchObject({
      extractor: "cf-markdown",
      text: expect.stringContaining(expected),
    });
  });

  async function extract(path: string, extractMode: "markdown" | "text" = "markdown") {
    const fetch = { cacheTtlMinutes: 0, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } };
    // Force basic extraction through the real tool, without plugin extractors.
    const tool = expectDefined(
      createWebFetchTool({
        config: { plugins: { enabled: false }, tools: { web: { fetch } } },
      }),
      "enabled web_fetch tool",
    );
    const result = await tool.execute("call", { url: `${baseUrl}${path}`, extractMode });
    return result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
});
