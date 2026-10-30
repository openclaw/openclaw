import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createWebFetchTool } from "./web-fetch.js";

const NUMERIC_DOCUMENT =
  '{"id":9007199254740993,"negative":-9007199254740993,"decimal":0.1234567890123456789,"sum":0.30000000000000004,"exponent":1e400,"negativeZero":-0,"big":12345678901234567890,"nested":[{"id":9223372036854775807}],"string":"9007199254740993","safe":42,"enabled":true,"empty":null}';

const VENDOR_JSON = "application/vnd.example+json; charset=utf-8";

function response(
  path: string,
  body: string,
  patterns: (RegExp | string)[],
  extractor = "json",
  contentType = "application/json",
  extractMode: "markdown" | "text" = "markdown",
  excludes: string[] = [],
) {
  return { path, body, patterns, contentType, extractor, extractMode, excludes };
}

function markdown(path: string, body: string, expected = body, mode: "text" | "markdown" = "text") {
  return response(path, body, [expected], "cf-markdown", "text/markdown", mode);
}

const MARKDOWN_CODE =
  '# Example\n\n- Read [the guide](https://example.com), \\![important](note.md), \\\\![diagram](image.png), and ![icon](icon.png).\n\n```text\n# comment\n- literal\n1. literal\n[label](https://example.com)\n![alt](image.png)\n`value`\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True\n```';
const UNCLOSED_CODE =
  '# literal\n- literal\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True';
const INLINE_FENCE = "Use ``` to start a code block.\nNext paragraph.";
const ZERO_SCALE =
  '<p>Visible article.</p><div style="transform:scale(0, 0)">Hidden flat content</div><div style="transform:scale3d(0, 0, 0)">Hidden 3D content</div><p style="transform:scale(0.5, 0.5)">Visible scaled content.</p>';
const RESPONSES = [
  response("/ordinary", '{"name":"example","count":42,"enabled":true,"items":[1,2]}', [
    /\{\n {2}"name": "example",\n {2}"count": 42,\n {2}"enabled": true,\n {2}"items": \[\n {4}1,\n {4}2\n {2}\]\n\}/u,
  ]),
  response(
    "/oversized",
    JSON.stringify({
      items: Array.from({ length: 2_000 }, (_, id) => ({ id, name: "ordinary value" })),
    }),
    [/\{\n {2}"items": \[\n {4}\{\n {6}"id": 0,\n {6}"name": "ordinary value"/u],
  ),
  response("/json", NUMERIC_DOCUMENT, [NUMERIC_DOCUMENT]),
  response("/vendor-json", NUMERIC_DOCUMENT, [NUMERIC_DOCUMENT], "json", VENDOR_JSON),
  response("/scalar", "9007199254740993", [/(?:^|\n)9007199254740993(?:\n|$)/u]),
  response("/array", "[9007199254740993,-0,1e400]", [
    /\[\s*9007199254740993\s*,\s*-0\s*,\s*1e400\s*\]/u,
  ]),
  response("/invalid", '{"id":9007199254740993', [/"id":9007199254740993/u], "raw"),
  response("/text", "record 9007199254740993", [/record 9007199254740993/u], "raw", "text/plain"),
  markdown("/markdown-code", MARKDOWN_CODE, MARKDOWN_CODE, "markdown"),
  markdown(
    "/markdown-code-text",
    MARKDOWN_CODE,
    'Example\n\nRead the guide, \\!important, \\\\, and .\n\n# comment\n- literal\n1. literal\n[label](https://example.com)\n![alt](image.png)\n`value`\n    if enabled:\n        print("two  spaces")\n\n\n\treturn True',
  ),
  markdown("/markdown-unclosed", `\`\`\`text\n${UNCLOSED_CODE}`, UNCLOSED_CODE),
  markdown("/markdown-inline-fence-prose", INLINE_FENCE),
  ...(["markdown", "text"] as const).map((mode) =>
    response(
      `/zero-scale-${mode}`,
      ZERO_SCALE,
      ["Visible article.", "Visible scaled content."],
      "raw-html",
      "text/html",
      mode,
      ["Hidden flat content", "Hidden 3D content"],
    ),
  ),
];

describe("web_fetch content fidelity through the real tool execute path", () => {
  let baseUrl: string;
  let reservation: Awaited<ReturnType<typeof reserveTestPortListener<Server>>> | undefined;
  const spillPaths = new Set<string>();
  beforeAll(async () => {
    reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          const fixture = RESPONSES.find(({ path }) => path === req.url);
          res.writeHead(fixture ? 200 : 404, {
            "content-type": fixture?.contentType ?? "text/plain",
          });
          res.end(fixture?.body ?? "not found");
        }),
    });
    baseUrl = `http://127.0.0.1:${reservation.claim.port}`;
  });
  afterAll(async () => {
    await Promise.all([...spillPaths].map((path) => rm(path, { force: true })));
    if (!reservation) {
      return;
    }
    try {
      await reservation.releaseListener();
    } finally {
      await reservation.claim.release();
    }
  });

  it.each(RESPONSES)(
    "preserves source literals from $path",
    async ({ path, body, extractor, patterns, extractMode, excludes }) => {
      const { envelope, text } = await extract(path, extractMode, 1_200);
      expect(envelope).toMatchObject({
        status: 200,
        extractor,
        truncated: path === "/oversized",
      });
      for (const pattern of patterns) {
        // This JSON fixture has no whitespace inside strings; compare its source
        // tokens without parsing (which would round the expected numeric values).
        expect(
          extractor === "json" && typeof pattern === "string" ? text.replace(/\s+/gu, "") : text,
        ).toEqual(
          typeof pattern === "string"
            ? expect.stringContaining(pattern)
            : expect.stringMatching(pattern),
        );
      }
      for (const hidden of excludes) {
        expect(text).not.toContain(hidden);
      }
      if (path === "/ordinary" || path === "/oversized") {
        expect(envelope.rawLength).toBe(JSON.stringify(JSON.parse(body), null, 2).length);
      }
    },
  );

  async function extract(
    path: string,
    extractMode: "markdown" | "text" = "markdown",
    maxChars?: number,
  ) {
    const fetch = { cacheTtlMinutes: 0, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } };
    // Force basic extraction through the real tool, without plugin extractors.
    const tool = expectDefined(
      createWebFetchTool({
        config: { plugins: { enabled: false }, tools: { web: { fetch } } },
      }),
      "enabled web_fetch tool",
    );
    const result = await tool.execute("call", { url: `${baseUrl}${path}`, extractMode, maxChars });
    const textBlock = expectDefined(
      result.content.find((block) => block.type === "text"),
      "text result",
    );
    // Decode only the envelope; parsing its source document would round the oracle too.
    const envelope: unknown = JSON.parse(textBlock.text);
    assert(isRecord(envelope) && typeof envelope.text === "string", "wrapped source document");
    if (isRecord(envelope.spill) && typeof envelope.spill.path === "string") {
      spillPaths.add(envelope.spill.path);
    }
    return { envelope, text: envelope.text };
  }
});
