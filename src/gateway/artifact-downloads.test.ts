import { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createImageProcessor } from "../media/image-processor.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  prepareArtifactDownload,
  prepareArtifactDownloadResponse,
} from "./artifact-download-projection.js";
import { createArtifactDownload, handleArtifactDownloadHttpRequest } from "./artifact-downloads.js";
import { createGatewayRequest as createRequest } from "./hooks-test-helpers.js";
import type { ArtifactRecord } from "./server-methods/artifacts-content.js";
import type { GatewayClient } from "./server-methods/client-types.js";

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

it.each(["current", "source", "connection", "expiry"] as const)(
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
      expect(response.res.statusCode).toBe(change === "current" ? 200 : 404);
      expect(response.end).toHaveBeenCalledExactlyOnceWith(
        change === "current" ? new Uint8Array(Buffer.from("captured body")) : "Not Found",
      );
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.each(["image", "file", "invalid-image"] as const)(
  "serves best-effort HTTP thumbnails and preserves original downloads (%s)",
  async (kind) => {
    const source =
      kind === "image"
        ? createSolidPngBuffer(1600, 800, { r: 24, g: 64, b: 128 })
        : Buffer.from("original");
    const artifact: ArtifactRecord = {
      id: "artifact_transcript_image_fixture",
      type: kind === "file" ? "file" : "image",
      title: "fixture",
      mimeType: kind === "file" ? "text/plain" : "image/png",
      download: { mode: "bytes" },
      data: source.toString("base64"),
    };
    const client = createClient();
    const grant = createArtifactDownload({
      client,
      prepared: prepareArtifactDownload(artifact)!,
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
    } else {
      expect(bytes).toEqual(new Uint8Array(source));
    }
    const head = await fetch("?variant=thumbnail", "HEAD");
    expect(head.end).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(head.setHeader).toHaveBeenCalledWith("Content-Length", String(bytes.byteLength));
    const range = await fetch("?variant=thumbnail", "GET", { range: "bytes=0-7" });
    expect(range.res.statusCode).toBe(206);
    expect(range.end).toHaveBeenCalledExactlyOnceWith(bytes.subarray(0, 8));
  },
);
