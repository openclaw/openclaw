import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewayByteStream,
  createImmutableFileValidators,
  resolveByteResponse,
  writeByteHeaders,
} from "./http-byte-range.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const FILE = { size: 10, mtimeMs: 1_752_000_000_123.5 };
const IMMUTABLE_FILE = { file: FILE, validators: createImmutableFileValidators(FILE) };
const LAST_MODIFIED = new Date(FILE.mtimeMs).toUTCString();
const FULL = { kind: "full", statusCode: 200 };
const NOT_MODIFIED = { kind: "not-modified", statusCode: 304 };
const ETAG = IMMUTABLE_FILE.validators.etag;

async function openMedia(body: string | Buffer) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-byte-stream-"));
  const filePath = path.join(directory, "media.bin");
  await fs.writeFile(filePath, body);
  const handle = await fs.open(filePath, "r");
  const closeHandle = vi.spyOn(handle, "close");
  const cleanup = async () => {
    if (handle.fd >= 0) {
      await handle.close();
    }
    await fs.rm(directory, { recursive: true, force: true });
  };
  return { handle, closeHandle, cleanup };
}

function resolveImmutableResponse(
  headers: Record<string, string | string[]>,
  overrides: Partial<Parameters<typeof resolveByteResponse>[0]> = {},
) {
  const entries = Object.entries(headers);
  return resolveByteResponse({
    ...IMMUTABLE_FILE,
    method: "GET",
    request: {
      headers: Object.fromEntries(
        entries.map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
      ),
      headersDistinct: Object.fromEntries(
        entries.map(([name, value]) => [name, Array.isArray(value) ? value : [value]]),
      ),
    },
    ...overrides,
  });
}

describe("resolveByteResponse", () => {
  it.each([
    { header: "bytes=4-", start: 4, end: 9, contentLength: 6 },
    { header: "bytes=-3", start: 7, end: 9, contentLength: 3 },
  ])("resolves range $header", ({ header, start, end, contentLength }) => {
    const plan = resolveImmutableResponse({ range: header });
    expect(plan).toMatchObject({
      kind: "partial",
      statusCode: 206,
      contentLength,
      range: { start, end },
    });
    const { res, setHeader } = makeMockHttpResponse();
    writeByteHeaders(res, plan);
    expect(res.statusCode).toBe(206);
    expect(setHeader).toHaveBeenCalledWith("Last-Modified", LAST_MODIFIED);
  });

  it.each(["bytes=broken", "items=0-1", "bytes=0-1,4-5"])(
    "falls back to a full response for malformed or multipart range %s",
    (rangeHeader) => {
      expect(resolveImmutableResponse({ range: rangeHeader })).toMatchObject({
        ...FULL,
        contentLength: 10,
      });
    },
  );

  it.each(["", '"different"'])(
    "ignores If-Modified-Since whenever any If-None-Match field is present (%j)",
    (ifNoneMatch) => {
      expect(
        resolveImmutableResponse({
          "if-none-match": ifNoneMatch,
          "if-modified-since": LAST_MODIFIED,
        }),
      ).toMatchObject(FULL);
    },
  );

  it.each([
    { etag: '"opaque,tag"', header: 'W/"opaque,tag"' },
    { etag: 'W/"opaque,tag"', header: '"opaque,tag"' },
  ])("weakly compares complete $header against $etag", ({ etag, header }) => {
    expect(
      resolveImmutableResponse(
        { "if-none-match": header },
        { validators: { ...IMMUTABLE_FILE.validators, etag } },
      ),
    ).toMatchObject(NOT_MODIFIED);
  });

  it.each([
    { label: "wildcard", header: "*" },
    { label: "list", header: `"other", ${ETAG}` },
    { label: "multiple headers", header: ['"other"', `W/${ETAG}`] },
  ])("returns 304 for a matching $label If-None-Match validator", ({ header }) => {
    const plan = resolveImmutableResponse({ "if-none-match": header });
    expect(plan).toEqual({ ...NOT_MODIFIED, etag: ETAG, lastModified: LAST_MODIFIED });
    const { res, setHeader } = makeMockHttpResponse();
    writeByteHeaders(res, plan);
    expect(res.statusCode).toBe(304);
    expect(Object.fromEntries(setHeader.mock.calls)).toMatchObject({
      ETag: ETAG,
      "Last-Modified": LAST_MODIFIED,
    });
    expect(setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
  });

  it("keeps the requested range when If-None-Match does not match", () => {
    expect(
      resolveImmutableResponse({
        range: "bytes=1-2",
        "if-range": ETAG,
        "if-none-match": '"stale"',
      }),
    ).toMatchObject({ kind: "partial", statusCode: 206, range: { start: 1, end: 2 } });
  });
});

describe("Gateway byte response descriptor lifecycle", () => {
  it.each(["client disconnect", "read revocation"] as const)(
    "closes the actual stream and descriptor after %s",
    async (reason) => {
      const size = 8 * 1024 * 1024;
      const { handle, closeHandle, cleanup } = await openMedia(Buffer.alloc(size, 7));
      const createReadStream = vi.spyOn(handle, "createReadStream");
      const { promise: responseClosed, resolve: resolveResponseClose } = createDeferred();
      const server = http.createServer((_request, response) => {
        const owner = createGatewayByteStream(response, handle, () => {
          response.statusCode = 404;
          response.end("not found");
        });
        const byteResponse = resolveByteResponse({ file: { size }, method: "GET" });
        writeByteHeaders(response, byteResponse);
        let chunks = 0;
        void owner.pipe(
          byteResponse,
          "GET",
          undefined,
          reason === "read revocation"
            ? {
                assertCurrent() {
                  if (++chunks > 1) {
                    throw new Error("Synthetic reader revoked");
                  }
                },
              }
            : undefined,
        );
        response.once("close", resolveResponseClose);
      });
      const origin = await listenLoopback(server);

      try {
        await new Promise<void>((resolve, reject) => {
          const request = http.get(origin, (response) => {
            response.once("data", () => {
              if (reason === "client disconnect") {
                response.destroy();
                resolve();
              }
            });
            if (reason === "read revocation") {
              response.once("aborted", resolve);
              response.once("end", () => reject(new Error("Revoked transfer completed")));
            }
          });
          request.once("error", reject);
        });
        await responseClosed;
        await vi.waitFor(() => {
          expect(closeHandle).toHaveBeenCalledOnce();
          expect(handle.fd).toBe(-1);
        });

        const streamedFile = createReadStream.mock.results[0]?.value;
        expect(streamedFile).toMatchObject({ destroyed: true, readableEnded: false });
      } finally {
        await closeHttpServer(server);
        await cleanup();
      }
    },
  );

  it("closes a newly opened descriptor when its response ended before streaming began", async () => {
    const { handle, closeHandle, cleanup } = await openMedia("media");
    const response = new http.ServerResponse({ method: "GET" } as http.IncomingMessage);
    response.end();
    const owner = createGatewayByteStream(response, handle, () => {});

    try {
      await owner.pipe(resolveByteResponse({ file: { size: 5 }, method: "GET" }), "GET");
      expect(closeHandle).toHaveBeenCalledOnce();
      expect(handle.fd).toBe(-1);
    } finally {
      await cleanup();
    }
  });
});
