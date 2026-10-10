import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewayByteStream,
  createImmutableFileValidators,
  resolveByteResponse,
  writeByteHeaders,
} from "./http-byte-range.js";

const FILE = { size: 10, mtimeMs: 1_752_000_000_123.5 };
const IMMUTABLE_FILE = { file: FILE, validators: createImmutableFileValidators(FILE) };
const LAST_MODIFIED = new Date(FILE.mtimeMs).toUTCString();

function createByteRequest(
  headers: Record<string, string | string[] | undefined>,
): Pick<IncomingMessage, "headers" | "headersDistinct"> {
  const entries = Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value] as const],
  );
  return {
    headers: Object.fromEntries(
      entries.map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
    ),
    headersDistinct: Object.fromEntries(
      entries.map(([name, value]) => [name, Array.isArray(value) ? value : [value]]),
    ),
  };
}

function resolveImmutableResponse(headers: Parameters<typeof createByteRequest>[0]) {
  return resolveByteResponse({
    ...IMMUTABLE_FILE,
    method: "GET",
    request: createByteRequest(headers),
  });
}

describe("resolveByteResponse", () => {
  it.each([
    { header: "bytes=4-", start: 4, end: 9, contentLength: 6 },
    { header: "bytes=-3", start: 7, end: 9, contentLength: 3 },
    { header: "bytes=2-5", start: 2, end: 5, contentLength: 4 },
  ])("resolves range $header", ({ header, start, end, contentLength }) => {
    expect(resolveImmutableResponse({ range: header })).toMatchObject({
      kind: "partial",
      statusCode: 206,
      contentLength,
      range: { start, end },
    });
  });

  it("returns 416 with the complete file size for an out-of-bounds range", () => {
    const plan = resolveImmutableResponse({ range: "bytes=10-20" });
    expect(plan).toMatchObject({
      kind: "unsatisfiable",
      statusCode: 416,
      contentLength: 0,
      size: 10,
    });

    const setHeader = vi.fn();
    const res = { statusCode: 0, setHeader } as unknown as ServerResponse;
    writeByteHeaders(res, plan);
    expect(res.statusCode).toBe(416);
    expect(setHeader).toHaveBeenCalledWith("Content-Range", "bytes */10");
  });

  it.each(["bytes=broken", "items=0-1", "bytes=0-1,4-5"])(
    "falls back to a full response for malformed or multipart range %s",
    (rangeHeader) => {
      expect(resolveImmutableResponse({ range: rangeHeader })).toMatchObject({
        kind: "full",
        statusCode: 200,
        contentLength: 10,
      });
    },
  );

  it("matches an If-Range date against the bounded emitted validator", () => {
    const nowMs = FILE.mtimeMs - 60_000;
    const emittedLastModified = new Date(nowMs).toUTCString();

    expect(
      resolveByteResponse({
        ...IMMUTABLE_FILE,
        nowMs,
        method: "GET",
        request: createByteRequest({ range: "bytes=1-2", "if-range": emittedLastModified }),
      }),
    ).toMatchObject({ kind: "partial", statusCode: 206, lastModified: emittedLastModified });
    expect(
      resolveByteResponse({
        ...IMMUTABLE_FILE,
        nowMs,
        method: "GET",
        request: createByteRequest({ range: "bytes=1-2", "if-range": LAST_MODIFIED }),
      }),
    ).toMatchObject({ kind: "full", statusCode: 200, lastModified: emittedLastModified });
  });

  it("bounds the future Last-Modified validator on HEAD not-modified responses", () => {
    const nowMs = FILE.mtimeMs - 60_000;
    const etag = IMMUTABLE_FILE.validators.etag;

    expect(
      resolveByteResponse({
        ...IMMUTABLE_FILE,
        method: "HEAD",
        nowMs,
        request: createByteRequest({ "if-none-match": etag }),
      }),
    ).toEqual({
      kind: "not-modified",
      statusCode: 304,
      etag,
      lastModified: new Date(nowMs).toUTCString(),
    });
  });

  it("honors a later If-Modified-Since date before ranges for HEAD", () => {
    expect(
      resolveByteResponse({
        ...IMMUTABLE_FILE,
        method: "HEAD",
        request: createByteRequest({
          "if-modified-since": new Date(Date.parse(LAST_MODIFIED) + 1_000).toUTCString(),
          range: "bytes=1-2",
          "if-range": '"stale"',
        }),
      }),
    ).toMatchObject({ kind: "not-modified", statusCode: 304, lastModified: LAST_MODIFIED });
  });

  it.each([
    {
      name: "before midnight",
      mtimeMs: Date.UTC(2017, 0, 1),
      statusCode: 200,
    },
    {
      name: "after the prior second",
      mtimeMs: Date.UTC(2016, 11, 31, 23, 59, 59),
      statusCode: 304,
    },
  ])("preserves leap second ordering for $name", ({ mtimeMs, statusCode }) => {
    expect(
      resolveByteResponse({
        file: { size: 10 },
        validators: createImmutableFileValidators({ size: 10, mtimeMs }),
        method: "GET",
        request: createByteRequest({ "if-modified-since": "Sat, 31 Dec 2016 23:59:60 GMT" }),
      }),
    ).toMatchObject({ kind: statusCode === 304 ? "not-modified" : "full", statusCode });
  });

  it("ignores an ISO timestamp in If-Modified-Since", () => {
    expect(
      resolveImmutableResponse({ "if-modified-since": new Date(FILE.mtimeMs).toISOString() }),
    ).toMatchObject({
      kind: "full",
      statusCode: 200,
    });
  });

  it.each(["", '"different"'])(
    "ignores If-Modified-Since whenever any If-None-Match field is present (%j)",
    (ifNoneMatch) => {
      expect(
        resolveImmutableResponse({
          "if-none-match": ifNoneMatch,
          "if-modified-since": LAST_MODIFIED,
        }),
      ).toMatchObject({ kind: "full", statusCode: 200 });
    },
  );

  it("ignores duplicate singleton dates hidden by Node's normalized headers", () => {
    const headers = { "if-modified-since": LAST_MODIFIED };

    expect(
      resolveByteResponse({
        ...IMMUTABLE_FILE,
        method: "GET",
        request: {
          headers,
          headersDistinct: {
            "if-modified-since": [
              LAST_MODIFIED,
              new Date(Date.parse(LAST_MODIFIED) - 1_000).toUTCString(),
            ],
          },
        },
      }),
    ).toMatchObject({ kind: "full", statusCode: 200 });
  });

  it.each([
    { etag: '"opaque,tag"', header: 'W/"opaque,tag"' },
    { etag: 'W/"opaque,tag"', header: '"opaque,tag"' },
  ])("weakly compares complete $header against $etag", ({ etag, header }) => {
    expect(
      resolveByteResponse({
        ...IMMUTABLE_FILE,
        validators: { ...IMMUTABLE_FILE.validators, etag },
        method: "GET",
        request: createByteRequest({ "if-none-match": header }),
      }),
    ).toMatchObject({ kind: "not-modified", statusCode: 304 });
  });

  it.each([
    { label: "wildcard", header: () => "*" },
    { label: "list", header: (etag: string) => `"other", ${etag}` },
    { label: "multiple headers", header: (etag: string) => ['"other"', `W/${etag}`] },
  ])("returns 304 for a matching $label If-None-Match validator", ({ header }) => {
    const etag = IMMUTABLE_FILE.validators.etag;
    const plan = resolveImmutableResponse({ "if-none-match": header(etag) });

    expect(plan).toEqual({
      kind: "not-modified",
      statusCode: 304,
      etag,
      lastModified: LAST_MODIFIED,
    });
    const setHeader = vi.fn();
    const res = { statusCode: 0, setHeader } as unknown as ServerResponse;
    writeByteHeaders(res, plan);
    expect(res.statusCode).toBe(304);
    expect(setHeader).toHaveBeenCalledWith("ETag", etag);
    expect(setHeader).toHaveBeenCalledWith("Last-Modified", LAST_MODIFIED);
    expect(setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
  });

  it("keeps the requested range when If-None-Match does not match", () => {
    const etag = IMMUTABLE_FILE.validators.etag;

    expect(
      resolveImmutableResponse({
        range: "bytes=1-2",
        "if-range": etag,
        "if-none-match": '"stale"',
      }),
    ).toMatchObject({ kind: "partial", statusCode: 206, range: { start: 1, end: 2 } });
  });

  it.each([{ label: "partial", rangeHeader: "bytes=1-2", statusCode: 206 }])(
    "emits the same Last-Modified validator on $label responses",
    ({ rangeHeader, statusCode }) => {
      const plan = resolveImmutableResponse({ range: rangeHeader });
      const setHeader = vi.fn();
      const res = { statusCode: 0, setHeader } as unknown as ServerResponse;

      writeByteHeaders(res, plan);

      expect(res.statusCode).toBe(statusCode);
      expect(setHeader).toHaveBeenCalledWith("Last-Modified", LAST_MODIFIED);
    },
  );
});

describe("Gateway byte response descriptor lifecycle", () => {
  it("destroys the real file stream and closes its descriptor once when its HTTP client disconnects", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-byte-stream-"));
    const filePath = path.join(directory, "media.bin");
    const body = Buffer.alloc(8 * 1024 * 1024, 7);
    await fs.writeFile(filePath, body);
    const handle = await fs.open(filePath, "r");
    const closeHandle = vi.spyOn(handle, "close");
    const createReadStream = vi.spyOn(handle, "createReadStream");
    const { promise: responseClosed, resolve: resolveResponseClose } = createDeferred();
    const server = http.createServer((_request, response) => {
      const owner = createGatewayByteStream(response, handle, () => {
        response.statusCode = 404;
        response.end("not found");
      });
      const byteResponse = resolveByteResponse({
        file: { size: body.byteLength },
        method: "GET",
      });
      writeByteHeaders(response, byteResponse);
      void owner.pipe(byteResponse, "GET");
      response.once("close", resolveResponseClose);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected test HTTP server to bind to a TCP port");
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port: address.port }, (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
        });
        request.once("error", reject);
      });
      await responseClosed;
      await vi.waitFor(() => {
        expect(closeHandle).toHaveBeenCalledOnce();
        expect(handle.fd).toBe(-1);
      });

      const streamedFile = createReadStream.mock.results[0]?.value;
      expect(streamedFile?.destroyed).toBe(true);
      expect(streamedFile?.readableEnded).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("closes a newly opened descriptor when its response ended before streaming began", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-byte-ended-"));
    const filePath = path.join(directory, "media.bin");
    await fs.writeFile(filePath, "media");
    const handle = await fs.open(filePath, "r");
    const closeHandle = vi.spyOn(handle, "close");
    const response = new http.ServerResponse({ method: "GET" } as http.IncomingMessage);
    response.end();
    const owner = createGatewayByteStream(response, handle, () => {});

    try {
      await owner.pipe(resolveByteResponse({ file: { size: 5 }, method: "GET" }), "GET");
      expect(closeHandle).toHaveBeenCalledOnce();
      expect(handle.fd).toBe(-1);
    } finally {
      if (handle.fd >= 0) {
        await handle.close();
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
