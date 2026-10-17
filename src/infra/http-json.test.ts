import { createServer, IncomingMessage, request, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  sendJson,
  sendJsonNoStore,
  sendJsonWithoutCharset,
  sendLengthFramedJson,
  writeJsonWithoutCharset,
} from "./http-json.js";

const writers = {
  plain: sendJson,
  private: sendJsonNoStore,
  framed: sendLengthFramedJson,
  bare: sendJsonWithoutCharset,
  committed: writeJsonWithoutCharset,
};
type Writer = keyof typeof writers;

describe("HTTP JSON representation", () => {
  let listener: Awaited<ReturnType<typeof reserveTestPortListener>>;

  beforeAll(async () => {
    listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
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
        const response = await new Promise<{
          status: number | undefined;
          headers: import("node:http").IncomingHttpHeaders;
          body: Buffer;
        }>((resolve, reject) => {
          const req = request(
            {
              host: "127.0.0.1",
              port: listener.claim.port,
              path: `/${writer}`,
              method,
              agent: false,
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.once("error", reject);
              res.once("end", () =>
                resolve({
                  status: res.statusCode,
                  headers: res.headers,
                  body: Buffer.concat(chunks),
                }),
              );
            },
          );
          req.once("error", reject);
          req.end();
        });
        expect(response.status).toBe(202);
        expect(response.headers["content-type"]).toBe(
          writer === "bare" || writer === "committed"
            ? "application/json"
            : "application/json; charset=utf-8",
        );
        expect(response.headers["cache-control"]).toBe(
          writer === "private" ? "no-store" : "private, no-cache",
        );
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["transfer-encoding"]).toBe(
          writer === "committed" && method === "GET" ? "chunked" : undefined,
        );
        expect(response.headers["content-length"]).toBe(
          (method === "GET" && writer !== "committed") || writer === "framed" ? "21" : undefined,
        );
        expect(response.body.toString("utf8")).toBe(method === "GET" ? '{"text":"🦞 café"}' : "");
      }
    },
  );

  it.each<Writer>(["plain", "private", "framed", "bare", "committed"])(
    "preserves %s header preparation when serialization fails",
    (writer) => {
      const res = new ServerResponse(new IncomingMessage(new Socket()));
      res.setHeader("X-Content-Type-Options", "nosniff");
      expect(() => writers[writer](res, 202, { value: 1n })).toThrow(TypeError);
      expect(res.headersSent).toBe(writer === "committed");
      expect(res.statusCode).toBe(writer === "framed" ? 200 : 202);
      expect(res.getHeader("Content-Type")).toBe(
        writer === "framed"
          ? undefined
          : writer === "bare" || writer === "committed"
            ? "application/json"
            : "application/json; charset=utf-8",
      );
      expect(res.getHeader("Cache-Control")).toBe(writer === "private" ? "no-store" : undefined);
      res.destroy();
    },
  );
});
