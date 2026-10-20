import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createWebFetchTool } from "./web-fetch.js";

const NUMERIC_DOCUMENT =
  '{"id":9007199254740993,"negative":-9007199254740993,"decimal":0.1234567890123456789,"sum":0.30000000000000004,"exponent":1e400,"negativeZero":-0,"big":12345678901234567890,"nested":[{"id":9223372036854775807}],"string":"9007199254740993","safe":42,"enabled":true,"empty":null}';

const NUMERIC_PATTERNS = [
  /"id"\s*:\s*9007199254740993\b/u,
  /"negative"\s*:\s*-9007199254740993\b/u,
  /"decimal"\s*:\s*0\.1234567890123456789\b/u,
  /"sum"\s*:\s*0\.30000000000000004\b/u,
  /"big"\s*:\s*12345678901234567890\b/u,
  /"exponent"\s*:\s*1e400\b/u,
  /"negativeZero"\s*:\s*-0\s*[,}]/u,
  /"id"\s*:\s*9223372036854775807\b/u,
  /"string"\s*:\s*"9007199254740993"/u,
  /"safe"\s*:\s*42\b/u,
  /"enabled"\s*:\s*true\b/u,
  /"empty"\s*:\s*null\b/u,
];
const VENDOR_JSON = "application/vnd.example+json; charset=utf-8";

function response(
  path: string,
  body: string,
  patterns: RegExp[],
  extractor = "json",
  contentType = "application/json",
) {
  return { path, body, patterns, contentType, extractor };
}

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
  response("/json", NUMERIC_DOCUMENT, NUMERIC_PATTERNS),
  response("/vendor-json", NUMERIC_DOCUMENT, NUMERIC_PATTERNS, "json", VENDOR_JSON),
  response("/scalar", "9007199254740993", [/(?:^|\n)9007199254740993(?:\n|$)/u]),
  response("/array", "[9007199254740993,-0,1e400]", [
    /\[\s*9007199254740993\s*,\s*-0\s*,\s*1e400\s*\]/u,
  ]),
  response("/invalid", '{"id":9007199254740993', [/"id":9007199254740993/u], "raw"),
  response("/text", "record 9007199254740993", [/record 9007199254740993/u], "raw", "text/plain"),
];

let reservation: Awaited<ReturnType<typeof reserveTestPortListener<Server>>> | undefined;
let baseUrl: string;
const spillPaths = new Set<string>();

beforeAll(async () => {
  reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, reply) => {
        const fixture = RESPONSES.find(({ path }) => path === request.url);
        if (!fixture) {
          reply.writeHead(404);
          reply.end();
          return;
        }
        reply.writeHead(200, { "content-type": fixture.contentType });
        reply.end(fixture.body);
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
  async ({ path, body, extractor, patterns }) => {
    const fetch = { cacheTtlMinutes: 0, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } };
    const config = { plugins: { enabled: false }, tools: { web: { fetch } } };
    const tool = expectDefined(createWebFetchTool({ config }), "enabled web_fetch tool");
    const result = await tool.execute("json-fidelity", {
      url: `${baseUrl}${path}`,
      maxChars: 1_200,
    });
    const textBlock = expectDefined(
      result.content.find((block) => block.type === "text"),
      "text result",
    );
    // Decode only the result envelope; parsing its source document would round the oracle too.
    const envelope: unknown = JSON.parse(textBlock.text);
    assert(isRecord(envelope) && typeof envelope.text === "string", "wrapped source document");
    if (isRecord(envelope.spill) && typeof envelope.spill.path === "string") {
      spillPaths.add(envelope.spill.path);
    }
    expect(envelope).toMatchObject({
      status: 200,
      extractor,
      truncated: path === "/oversized",
    });
    for (const pattern of patterns) {
      expect(envelope.text).toMatch(pattern);
    }
    if (path === "/ordinary" || path === "/oversized") {
      expect(envelope.rawLength).toBe(JSON.stringify(JSON.parse(body), null, 2).length);
    }
  },
);
