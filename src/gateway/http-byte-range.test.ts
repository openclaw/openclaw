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

const full = { kind: "full", statusCode: 200, contentLength: 10 };
const unchanged = { kind: "not-modified", statusCode: 304 };
const partial = (start: number, end: number) => ({
  kind: "partial",
  statusCode: 206,
  contentLength: end - start + 1,
  range: { start, end },
});
const ranged = { "if-range": ETAG, "if-none-match": '"stale"' };
const since = { "if-modified-since": LAST_MODIFIED };
type ResponseCase = [Record<string, string | string[]>, { statusCode: number }, string?];
it.each([
  [{ ...ranged, range: "bytes=4-" }, partial(4, 9)],
  [{ ...ranged, range: "bytes=-3" }, partial(7, 9)],
  [{ range: "bytes=broken" }, full],
  [{ range: "bytes=0-1,4-5" }, full],
  [{ ...since, "if-none-match": "" }, full],
  [{ ...since, "if-none-match": '"different"' }, full],
  [{ "if-none-match": "*" }, unchanged],
  [{ "if-none-match": `"other", ${ETAG}` }, unchanged],
  [{ "if-none-match": ['"other"', `W/${ETAG}`] }, unchanged],
  [{ "if-none-match": 'W/"opaque,tag"' }, unchanged, '"opaque,tag"'],
  [{ "if-none-match": '"opaque,tag"' }, unchanged, 'W/"opaque,tag"'],
] satisfies ResponseCase[])(
  "resolves conditional byte response %j",
  (headers, expected, etag = ETAG) => {
    const plan = resolveImmutableResponse(headers, {
      validators: { ...IMMUTABLE_FILE.validators, etag },
    });
    expect(plan).toMatchObject({ ...expected, etag, lastModified: LAST_MODIFIED });
    const { res, setHeader } = makeMockHttpResponse();
    writeByteHeaders(res, plan);
    expect(res.statusCode).toBe(expected.statusCode);
    expect(Object.fromEntries(setHeader.mock.calls)).toMatchObject({
      ETag: etag,
      "Last-Modified": LAST_MODIFIED,
    });
    if (plan.kind === "not-modified") {
      expect(setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
    }
  },
);

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
