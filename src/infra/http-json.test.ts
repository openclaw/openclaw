import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import * as json from "./http-json.js";

const writers = {
  plain: json.sendJson,
  private: json.sendJsonNoStore,
  framed: json.sendLengthFramedJson,
  bare: json.sendJsonWithoutCharset,
  committed: json.writeJsonWithoutCharset,
};
type Writer = keyof typeof writers;
const contentType = (writer: Writer) =>
  writer === "bare" || writer === "committed"
    ? "application/json"
    : "application/json; charset=utf-8";

let listener: Awaited<ReturnType<typeof reserveTestPortListener>>;
let serializationFailure: unknown;

beforeAll(async () => {
  listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        if (req.url === "/committed-serialization-failure") {
          try {
            json.writeJsonWithoutCharset(res, 202, { value: 1n });
          } catch (error) {
            serializationFailure = error;
          }
          res.end();
          return;
        }
        const writer = writers[req.url?.slice(1) as Writer];
        res.setHeader("Cache-Control", "private, no-cache");
        res.setHeader("X-Content-Type-Options", "nosniff");
        writer(res, 202, { text: "🦞 café" });
      }),
  });
});

afterAll(async () => {
  try {
    await listener.releaseListener();
  } finally {
    await listener.claim.release();
  }
});

it.each<Writer>(["plain", "private", "framed", "bare", "committed"])(
  "preserves %s JSON bytes, cache policy and HEAD framing",
  async (writer) => {
    for (const method of ["GET", "HEAD"]) {
      const res = await fetch(`http://127.0.0.1:${listener.claim.port}/${writer}`, {
        method,
        headers: { Connection: "close" },
      });
      const body = await res.text();
      expect(res.status).toBe(202);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        "content-type": contentType(writer),
        "cache-control": writer === "private" ? "no-store" : "private, no-cache",
        "x-content-type-options": "nosniff",
      });
      expect(res.headers.get("transfer-encoding")).toBe(
        writer === "committed" && method === "GET" ? "chunked" : null,
      );
      expect(res.headers.get("content-length")).toBe(
        (method === "GET" && writer !== "committed") || writer === "framed" ? "21" : null,
      );
      expect(body).toBe(method === "GET" ? '{"text":"🦞 café"}' : "");
    }
  },
);

it("preserves committed wire headers when serialization fails", async () => {
  serializationFailure = undefined;
  const res = await fetch(
    `http://127.0.0.1:${listener.claim.port}/committed-serialization-failure`,
    { headers: { Connection: "close" } },
  );
  const body = await res.text();
  expect(serializationFailure).toBeInstanceOf(TypeError);
  expect(res.status).toBe(202);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(body).toBe("");
});

it.each<Writer>(["plain", "private", "framed", "bare", "committed"])(
  "preserves %s header preparation when serialization fails",
  (writer) => {
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    expect(() => writers[writer](res, 202, { value: 1n })).toThrow(TypeError);
    expect(res.headersSent).toBe(writer === "committed");
    expect(res.statusCode).toBe(writer === "framed" ? 200 : 202);
    if (!res.headersSent) {
      expect(res.getHeader("Content-Type")).toBe(
        writer === "framed" ? undefined : contentType(writer),
      );
    }
    expect(res.getHeader("Cache-Control")).toBe(writer === "private" ? "no-store" : undefined);
    res.destroy();
  },
);
