import { createServer, ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { crc32 } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { createNoisyPngBuffer, createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createImageProcessor } from "../media/image-processor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  createArtifactDownload,
  createManagedArtifactDownload,
  clearArtifactDownloads,
  pruneExpiredArtifactDownloads,
} from "./artifact-download-grants.js";
import {
  prepareArtifactDownload,
  prepareArtifactDownloadResponse,
} from "./artifact-download-projection.js";
import { handleArtifactDownloadHttpRequest } from "./artifact-downloads.js";
import type { ArtifactRecord } from "./artifacts-content.js";
import { createGatewayRequest as createRequest } from "./hooks-test-helpers.js";
import { resolveByteResponse } from "./http-byte-range.js";
import { ANIMATED_GIF_BYTES, APNG_BYTES } from "./http-image.test-support.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";

afterEach(clearArtifactDownloads);

const solidPng = (width: number, height: number, a = 255) =>
  createSolidPngBuffer(width, height, { r: 24, g: 64, b: 128, a });
async function jpeg(source: Buffer) {
  return (await createImageProcessor().encode(source, { format: "jpeg" })).data;
}
async function expectWebp(bytes: Uint8Array, width: number, height: number) {
  expect(await createImageProcessor().probe(bytes)).toMatchObject({
    format: "webp",
    width,
    height,
  });
}

function createClient(signal = new AbortController().signal): GatewayClient {
  return {
    connId: "artifact-reader",
    connectionSignal: signal,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", version: "test", platform: "test", mode: "test" },
    },
  };
}

function artifactFrom(source: Buffer, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: "artifact_fixture",
    type: "image",
    title: "fixture",
    mimeType: "image/png",
    download: { mode: "bytes" },
    data: source.toString("base64"),
    ...overrides,
  };
}

const fileArtifact = (text: string) =>
  artifactFrom(Buffer.from(text), { type: "file", mimeType: "text/plain" });

function grantFor(
  client: GatewayClient,
  artifact: ArtifactRecord,
  overrides: Partial<Parameters<typeof createArtifactDownload>[0]> = {},
) {
  return createArtifactDownload({
    client,
    prepared: prepareArtifactDownload(artifact)!,
    release: vi.fn(),
    assertCurrent() {},
    read: async (request) => prepareArtifactDownloadResponse(artifact, request),
    ...overrides,
  });
}

function requestDownload(
  client: GatewayClient,
  path: string,
  method = "GET",
  headers?: Record<string, string>,
) {
  const req = createRequest({ path, method, headers });
  const res = new ServerResponse(req);
  const end = vi.spyOn(res, "end").mockReturnValue(res);
  const pending = handleArtifactDownloadHttpRequest(req, res, {
    clients: new Set([client]),
    basePath: "",
  });
  return { res, end, pending };
}

async function expectNotFound(response: ReturnType<typeof requestDownload>) {
  expect(await response.pending).toBe(true);
  expect(response.res.statusCode).toBe(404);
  expect(response.end).toHaveBeenCalledExactlyOnceWith("Not Found");
}

function listen(client: GatewayClient, before?: (res: ServerResponse) => void) {
  return reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        before?.(res);
        void handleArtifactDownloadHttpRequest(req, res, {
          clients: new Set([client]),
          basePath: "",
        });
      }),
  });
}

async function close(server: Awaited<ReturnType<typeof listen>>) {
  server.listener.closeAllConnections();
  await server.releaseListener();
  await server.claim.release();
}

function apngWithLargeMetadata(): Buffer {
  const chunk = Buffer.alloc(1024 * 1024 + 32, 0x61);
  chunk.writeUInt32BE(chunk.length - 12);
  chunk.write("tEXtcomment\0", 4, "ascii");
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([APNG_BYTES.subarray(0, 33), chunk, APNG_BYTES.subarray(33)]);
}

function corruptPng() {
  const source = solidPng(1600, 800);
  const start = source.indexOf("IDAT") + 4;
  source.fill(0, start, start + source.readUInt32BE(start - 8));
  return source;
}

it.each(["source", "connection", "expiry"] as const)(
  "rechecks captured download authority after the read settles (%s)",
  async (change) => {
    using clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const controller = new AbortController();
    const client = createClient(controller.signal);
    const artifact = fileArtifact("captured body");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let sourceCurrent = true;
    const grantOptions = {
      assertCurrent() {
        if (!sourceCurrent) {
          throw new Error("Captured artifact authority retired");
        }
      },
      async read(request: Parameters<typeof prepareArtifactDownloadResponse>[1]) {
        entered.resolve();
        await release.promise;
        return prepareArtifactDownloadResponse(artifact, request);
      },
    };
    const grant = grantFor(client, artifact, grantOptions);
    const response = requestDownload(client, grant.url);
    try {
      await entered.promise;
      expect(response.end).not.toHaveBeenCalled();
      if (change === "source") {
        sourceCurrent = false;
        grantOptions.assertCurrent = () => undefined;
      } else if (change === "connection") {
        controller.abort();
      } else if (change === "expiry") {
        clock.mockReturnValue(Date.parse(grant.expiresAt));
      }
      release.resolve();
      await expectNotFound(response);
    } finally {
      release.resolve();
      await response.pending;
    }
  },
);

it.each([
  ["invalid-image", () => Buffer.from("original"), "image/png"],
  ["corrupt-png", corruptPng, "image/png"],
  ["gif", () => ANIMATED_GIF_BYTES, "image/gif"],
  ["apng", () => APNG_BYTES, "image/png"],
  ["apng-metadata", apngWithLargeMetadata, "image/png"],
] as const)(
  "refuses an unsupported thumbnail without falling back to its original (%s)",
  async (_kind, makeSource, mimeType) => {
    const source = await makeSource();
    const client = createClient();
    const grant = grantFor(client, artifactFrom(source, { mimeType }));
    await expectNotFound(requestDownload(client, grant.url + "?variant=thumbnail"));
  },
);

it("ignores image variants for files while retaining download security headers", async () => {
  const client = createClient();
  const grant = grantFor(client, fileArtifact("original"));
  const response = requestDownload(client, grant.url + "?variant=thumbnail");
  expect(await response.pending).toBe(true);
  expect(response.res.statusCode).toBe(200);
  expect(response.end).toHaveBeenCalledExactlyOnceWith(new Uint8Array(Buffer.from("original")));
  expect(response.res.getHeaders()).toMatchObject({
    "content-type": "text/plain",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    "content-length": "8",
    "content-disposition": expect.stringMatching(/^attachment;/),
  });
});

it.each(["missing", "stream", "body-and-stream"] as const)(
  "refuses unavailable thumbnail bytes without opening an original stream (%s)",
  async (kind) => {
    const source = solidPng(32, 16);
    const artifact = artifactFrom(source, { title: "photo.png" });
    const stream = vi.fn(async function* () {
      yield source;
    });
    const client = createClient();
    const grant = grantFor(client, artifact, {
      release() {},
      read: async (request) => {
        const prepared = prepareArtifactDownloadResponse(artifact, request)!;
        return {
          ...prepared,
          body: kind === "body-and-stream" ? prepared.body : undefined,
          stream: kind === "missing" ? undefined : stream,
        };
      },
    });
    const response = requestDownload(client, grant.url + "?variant=thumbnail");
    await expectNotFound(response);
    expect(stream).not.toHaveBeenCalled();
  },
);

it("serves distinct fixed WebP renditions over HTTP with alpha, orientation, and exact originals", async () => {
  const processor = createImageProcessor();
  const client = createClient();
  const server = await listen(client);
  const grantImage = (source: Buffer, mimeType = "image/png") =>
    grantFor(client, artifactFrom(source, { title: "photo.png", mimeType })).url;
  const fetchImage = async (url: string, method = "GET", headers?: Record<string, string>) => {
    const response = await fetch(`http://127.0.0.1:${server.claim.port}${url}`, {
      method,
      headers,
      redirect: "error",
    });
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  try {
    const source = solidPng(2400, 1200, 96);
    const url = grantImage(source);
    let defaultBytes: Buffer | undefined;
    for (const [width, ceiling] of [
      [480, 96],
      [960, 256],
      [1920, 512],
    ] as const) {
      const { response, bytes } = await fetchImage(url + "?variant=thumbnail&width=" + width);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("content-disposition")).toContain("-preview.webp");
      expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
      expect(bytes.byteLength).toBeLessThanOrEqual(ceiling * 1024);
      await expectWebp(bytes, width, width / 2);
      expect(await processor.transparency(bytes)).toMatchObject({ hasTransparentPixels: true });
      if (width === 960) {
        defaultBytes = bytes;
      }
    }
    for (const query of ["", "&width=481", "&width=999999", "&width=-1", "&width=960.5"]) {
      const { bytes } = await fetchImage(url + "?variant=thumbnail" + query);
      expect(bytes).toEqual(defaultBytes);
    }
    for (const query of ["?width=480", "?variant=unknown"]) {
      const original = await fetchImage(url + query);
      expect(original.response.headers.get("content-type")).toBe("image/png");
      expect(original.bytes).toEqual(source);
    }
    const head = await fetchImage(url + "?variant=thumbnail", "HEAD");
    expect(head.bytes.length).toBe(0);
    expect(head.response.headers.get("content-length")).toBe(String(defaultBytes!.length));
    const range = await fetchImage(url + "?variant=thumbnail", "GET", { range: "bytes=0-7" });
    expect(range.response.status).toBe(206);
    expect(range.bytes).toEqual(defaultBytes!.subarray(0, 8));

    // Dense images may step down, but may not evade the selected rendition's byte ceiling.
    const denseUrl = grantImage(createNoisyPngBuffer(1600, 800));
    const dense = await fetchImage(denseUrl + "?variant=thumbnail&width=480");
    expect(dense.response.status).toBe(200);
    expect(dense.bytes.byteLength).toBeLessThanOrEqual(96 * 1024);
    await expectWebp(dense.bytes, 240, 120);

    const sourceJpeg = await jpeg(solidPng(32, 16));
    const orientation = Buffer.from(
      "ffe1002245786966000049492a0008000000010012010300010000000600000000000000",
      "hex",
    );
    const orientedUrl = grantImage(
      Buffer.concat([sourceJpeg.subarray(0, 2), orientation, sourceJpeg.subarray(2)]),
      "image/jpeg",
    );
    const oriented = await fetchImage(orientedUrl + "?variant=thumbnail&width=1920");
    await expectWebp(oriented.bytes, 16, 32);
  } finally {
    await close(server);
  }
});

it("releases retained sharing facts on unused expiry, eviction, and disconnect", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_000);
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:grant-lifetime";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "grant-lifetime", updatedAt: 1 },
    );
    const prepared = prepareArtifactDownload(fileArtifact("hello"))!;
    for (const reason of ["expiry", "eviction", "disconnect", "shutdown"]) {
      for (const kind of ["bytes", "managed"]) {
        const controller = new AbortController();
        const client = createClient(controller.signal);
        const facts = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
        const current = () => facts.readCurrent(cfg);
        const release = vi.fn(facts.release);
        const read = vi.fn(async () => undefined);
        try {
          const authority = {
            client,
            assertCurrent: () => void current(),
            release,
          };
          const grant =
            kind === "bytes"
              ? createArtifactDownload({ ...authority, prepared, read })
              : createManagedArtifactDownload({
                  ...authority,
                  path: "/api/chat/media/outgoing/session/attachment/full",
                });
          expect(current().target.entry.sessionId).toBe("grant-lifetime");
          if (reason === "expiry") {
            pruneExpiredArtifactDownloads(Date.parse(grant.expiresAt), [client]);
          } else if (reason === "eviction") {
            for (let index = 0; index < 128; index += 1) {
              createArtifactDownload({ client, prepared, assertCurrent() {}, read, release() {} });
            }
          } else if (reason === "shutdown") {
            clearArtifactDownloads();
          } else {
            controller.abort();
            if (kind === "managed") {
              expect(release).not.toHaveBeenCalled();
              expect(current().target.entry.sessionId).toBe("grant-lifetime");
              pruneExpiredArtifactDownloads(Date.parse(grant.expiresAt));
            }
          }
          expect(release, reason).toHaveBeenCalledOnce();
          expect(current, reason).toThrow(SessionMutationFactsUnavailableError);
          expect(read).not.toHaveBeenCalled();
          controller.abort();
          pruneExpiredArtifactDownloads(Number.MAX_SAFE_INTEGER, [client]);
          expect(release, reason).toHaveBeenCalledOnce();
        } finally {
          controller.abort();
          facts.release();
        }
      }
    }
  });
});

it("backpressures HTTP streams across URL expiry and closes their source on browser abort", async () => {
  const connection = new AbortController();
  const client = createClient(connection.signal);
  const started = createDeferredCore<ServerResponse>();
  const firstRead = createDeferredCore();
  const closed = createDeferredCore();
  const chunkBytes = 512 * 1024;
  const size = 64 * 1024 * 1024;
  let reads = 0;
  const release = vi.fn();
  const artifact = {
    id: "stream",
    type: "file",
    title: "large.bin",
    sizeBytes: size,
    mimeType: "application/octet-stream",
    download: { mode: "url" as const },
  };
  const grant = createArtifactDownload({
    client,
    prepared: { artifact, digest: "immutable-stream" },
    assertCurrent() {},
    release,
    read: async () => ({
      artifact,
      response: resolveByteResponse({ file: { size } }),
      async *stream(signal) {
        try {
          while (reads * chunkBytes < size) {
            signal.throwIfAborted();
            reads++;
            firstRead.resolve();
            yield Buffer.alloc(chunkBytes, 0x61);
          }
        } finally {
          closed.resolve();
        }
      },
    }),
  });
  const server = await listen(client, (res) => {
    // Hold the real socket's writes: the source must wait for drain, not collect the file.
    res.cork();
    started.resolve(res);
  });
  const abort = new AbortController();
  try {
    const fetching = fetch("http://127.0.0.1:" + server.claim.port + grant.url, {
      signal: abort.signal,
    });
    const res = await started.promise;
    await firstRead.promise;
    await setImmediate();
    expect(res.writableNeedDrain).toBe(true);
    expect(reads).toBeLessThanOrEqual(2);
    await setImmediate();
    expect(reads).toBeLessThanOrEqual(2);
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(Date.parse(grant.expiresAt));
    pruneExpiredArtifactDownloads(Date.now(), [client]);
    expect(release).not.toHaveBeenCalled();
    const expired = await fetch("http://127.0.0.1:" + server.claim.port + grant.url);
    expect(expired.status).toBe(404);
    await expired.arrayBuffer();
    res.uncork();
    const response = await fetching;
    const first = await response.body!.getReader().read();
    expect(first.value!.length).toBeGreaterThan(0);
    expect(first.value!.every((byte) => byte === 0x61)).toBe(true);
    abort.abort();
    await closed.promise;
    await setImmediate();
    expect(release).toHaveBeenCalledOnce();
    expect(reads * chunkBytes).toBeLessThan(size);
  } finally {
    abort.abort();
    connection.abort();
    await close(server);
  }
});
