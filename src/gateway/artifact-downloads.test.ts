import { ServerResponse } from "node:http";
import { crc32 } from "node:zlib";
import { expect, it, vi } from "vitest";
import { createNoisyPngBuffer, createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createImageProcessor } from "../media/image-processor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createArtifactDownload,
  pruneExpiredArtifactDownloads,
} from "./artifact-download-grants.js";
import {
  prepareArtifactDownload,
  prepareArtifactDownloadResponse,
} from "./artifact-download-projection.js";
import { handleArtifactDownloadHttpRequest } from "./artifact-downloads.js";
import { createGatewayRequest as createRequest } from "./hooks-test-helpers.js";
import { ANIMATED_GIF_BYTES, APNG_BYTES } from "./http-image.test-support.js";
import { encodeImageThumbnail } from "./managed-image-thumbnail-cache.js";
import type { ArtifactRecord } from "./server-methods/artifacts-content.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";

function createResponse() {
  const res = new ServerResponse(createRequest({ path: "/" }));
  return {
    res,
    setHeader: vi.spyOn(res, "setHeader"),
    end: vi.spyOn(res, "end").mockReturnValue(res),
  };
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

function apngWithLargeMetadata(): Buffer {
  const chunk = Buffer.alloc(1024 * 1024 + 32, 0x61);
  chunk.writeUInt32BE(chunk.length - 12);
  chunk.write("tEXtcomment\0", 4, "ascii");
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([APNG_BYTES.subarray(0, 33), chunk, APNG_BYTES.subarray(33)]);
}

it.each(["source", "connection", "expiry"] as const)(
  "rechecks captured download authority after the read settles (%s)",
  async (change) => {
    using clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const controller = new AbortController();
    const client = createClient(controller.signal);
    const artifact: ArtifactRecord = {
      id: "artifact_fixture",
      type: "file",
      title: "captured.txt",
      mimeType: "text/plain",
      download: { mode: "bytes" },
      data: "Y2FwdHVyZWQgYm9keQ==",
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let sourceCurrent = true;
    const grantOptions: Parameters<typeof createArtifactDownload>[0] = {
      client,
      prepared: prepareArtifactDownload(artifact)!,
      release: vi.fn(),
      assertCurrent() {
        if (!sourceCurrent) {
          throw new Error("Captured artifact authority retired");
        }
      },
      async read(request) {
        entered.resolve();
        await release.promise;
        return prepareArtifactDownloadResponse(artifact, request);
      },
    };
    const grant = createArtifactDownload(grantOptions);
    const response = createResponse();
    const pending = handleArtifactDownloadHttpRequest(
      createRequest({ path: grant.url }),
      response.res,
      { clients: new Set([client]), basePath: "" },
    );
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
      expect(await pending).toBe(true);
      expect(response.res.statusCode).toBe(404);
      expect(response.end).toHaveBeenCalledExactlyOnceWith("Not Found");
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.each(["image", "file", "invalid-image", "gif", "apng", "apng-metadata", "compact"] as const)(
  "serves best-effort HTTP thumbnails and preserves original downloads (%s)",
  async (kind) => {
    const source =
      kind === "image"
        ? createSolidPngBuffer(1600, 800, { r: 24, g: 64, b: 128 })
        : kind === "gif"
          ? ANIMATED_GIF_BYTES
          : kind === "apng"
            ? APNG_BYTES
            : kind === "apng-metadata"
              ? apngWithLargeMetadata()
              : kind === "compact"
                ? (
                    await createImageProcessor().encode(createNoisyPngBuffer(32, 32), {
                      format: "jpeg",
                      quality: 10,
                    })
                  ).data
                : Buffer.from("original");
    if (kind === "compact") {
      expect((await encodeImageThumbnail(source)).byteLength).toBeGreaterThan(source.byteLength);
    }
    const artifact: ArtifactRecord = {
      id: "artifact_transcript_image_fixture",
      type: kind === "file" ? "file" : "image",
      title: "fixture",
      mimeType:
        kind === "file"
          ? "text/plain"
          : kind === "gif"
            ? "image/gif"
            : kind === "compact"
              ? "image/jpeg"
              : "image/png",
      download: { mode: "bytes" },
      data: source.toString("base64"),
    };
    const client = createClient();
    const grant = createArtifactDownload({
      client,
      prepared: prepareArtifactDownload(artifact)!,
      release: vi.fn(),
      assertCurrent() {},
      read: async (request) => prepareArtifactDownloadResponse(artifact, request),
    });
    const fetch = async (query: string, method = "GET", headers?: Record<string, string>) => {
      const response = createResponse();
      expect(
        await handleArtifactDownloadHttpRequest(
          createRequest({ path: `${grant.url}${query}`, method, headers }),
          response.res,
          { clients: new Set([client]), basePath: "" },
        ),
      ).toBe(true);
      return response;
    };
    for (const query of ["", "?variant=unknown"]) {
      const full = await fetch(query);
      expect(full.end).toHaveBeenCalledExactlyOnceWith(new Uint8Array(source));
    }
    const thumbnail = await fetch("?variant=thumbnail");
    const bytes = thumbnail.end.mock.calls[0]?.[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("Expected image response bytes");
    }
    expect(thumbnail.res.statusCode).toBe(200);
    for (const [name, value] of Object.entries({
      "content-type": artifact.mimeType,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
      "Content-Length": String(bytes.byteLength),
    })) {
      expect(thumbnail.setHeader).toHaveBeenCalledWith(name, value);
    }
    expect(thumbnail.setHeader).toHaveBeenCalledWith(
      "content-disposition",
      expect.stringMatching(/^attachment;/),
    );
    if (kind === "image") {
      expect(await createImageProcessor().probe(bytes)).toMatchObject({ width: 1200, height: 600 });
      expect(bytes).not.toEqual(new Uint8Array(source));
      expect(bytes.byteLength).toBeLessThan(source.byteLength);
    } else {
      expect(Buffer.from(bytes).equals(source)).toBe(true);
    }
    const head = await fetch("?variant=thumbnail", "HEAD");
    expect(head.end).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(head.setHeader).toHaveBeenCalledWith("Content-Length", String(bytes.byteLength));
    const range = await fetch("?variant=thumbnail", "GET", { range: "bytes=0-7" });
    expect(range.res.statusCode).toBe(206);
    expect(range.end).toHaveBeenCalledExactlyOnceWith(bytes.subarray(0, 8));
  },
);

it("releases retained sharing facts on unused expiry, eviction, and disconnect", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_000);
    const cfg = {};
    const sessionKey = "agent:main:grant-lifetime";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "grant-lifetime", updatedAt: 1 },
    );
    const prepared = prepareArtifactDownload({
      id: "artifact_lifetime",
      type: "file",
      title: "lifetime.txt",
      mimeType: "text/plain",
      download: { mode: "bytes" },
      data: "aGVsbG8=",
    })!;
    for (const reason of ["expiry", "eviction", "disconnect"]) {
      const controller = new AbortController();
      const client = createClient(controller.signal);
      const facts = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
      const release = vi.fn(facts.release);
      const read = vi.fn(async () => undefined);
      try {
        const grant = createArtifactDownload({
          client,
          prepared,
          assertCurrent: () => {
            facts.readCurrent(cfg);
          },
          read,
          release,
        });
        expect(facts.readCurrent(cfg).target.entry.sessionId).toBe("grant-lifetime");
        if (reason === "expiry") {
          pruneExpiredArtifactDownloads([client], Date.parse(grant.expiresAt));
        } else if (reason === "eviction") {
          for (let index = 0; index < 128; index += 1) {
            createArtifactDownload({ client, prepared, assertCurrent() {}, read, release() {} });
          }
        } else {
          controller.abort();
        }
        expect(release, reason).toHaveBeenCalledOnce();
        expect(() => facts.readCurrent(cfg), reason).toThrow(SessionMutationFactsUnavailableError);
        expect(read).not.toHaveBeenCalled();
        controller.abort();
        pruneExpiredArtifactDownloads([client], Number.MAX_SAFE_INTEGER);
        expect(release, reason).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
        facts.release();
      }
    }
  });
});
