import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  prepareArtifactDownload,
  prepareArtifactDownloadResponse,
} from "./artifact-download-projection.js";
import { createArtifactDownload, handleArtifactDownloadHttpRequest } from "./artifact-downloads.js";
import { createRequest, createResponse } from "./server-http.test-harness.js";
import type { ArtifactRecord } from "./server-methods/artifacts-content.js";
import type { GatewayClient } from "./server-methods/client-types.js";

it.each(["current", "source", "connection", "expiry"] as const)(
  "rechecks captured download authority after the read settles (%s)",
  async (change) => {
    using clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const controller = new AbortController();
    const client: GatewayClient = {
      connId: "artifact-reader",
      connectionSignal: controller.signal,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", version: "test", platform: "test", mode: "test" },
      },
    };
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
