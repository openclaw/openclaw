import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { withNodeWorkerTransferHttpRequest } from "../../node-host/node-worker-transfer-http.js";
import { nodeWorkspaceTransferManifestPath } from "../../worker/node-workspace-transfer-protocol.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("workspace manifest HTTP negotiation", () => {
  it("negotiates gzip only for authorized manifests while retaining identity peers", async () => {
    const root = tempDirs.make("workspace-transfer-encoding-");
    const localPath = path.join(root, "source");
    await fs.mkdir(localPath);
    await fs.writeFile(path.join(localPath, "input.txt"), "transfer content\n");
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => ({
        credential: { ownerEpoch: 1, sessionId: "session" },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    try {
      const { snapshot, token } = await service.prepareSync({
        environmentId: "environment",
        ownerEpoch: 1,
        sessionId: "session",
        generation: 1,
        localPath,
        isAuthorized: () => true,
      });
      const request = {
        gatewayUrl: server.gatewayUrl,
        routePath: nodeWorkspaceTransferManifestPath("environment", snapshot.manifestRef),
        method: "GET" as const,
        token,
      };
      const requestManifest = async (header?: string, requestToken = token) =>
        await withNodeWorkerTransferHttpRequest(
          {
            ...request,
            token: requestToken,
            headers: header ? { "accept-encoding": header } : undefined,
          },
          async (response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of response) {
              chunks.push(Buffer.from(chunk));
            }
            return {
              statusCode: response.statusCode,
              headers: response.headers,
              bytes: Buffer.concat(chunks),
            };
          },
        );
      for (const { header, encoding, code } of [
        { header: "gzip", encoding: "gzip", code: 200 },
        { header: undefined, encoding: undefined, code: 200 },
        { header: "identity", encoding: undefined, code: 200 },
        { header: "gzip;q=0.5, identity;q=1", encoding: undefined, code: 200 },
        { header: "gzip;q=1, identity;q=0.5", encoding: "gzip", code: 200 },
        { header: "br", encoding: undefined, code: 200 },
        { header: "*;q=0", encoding: undefined, code: 406 },
        { header: "gzip;q=0, *;q=1", encoding: undefined, code: 200 },
        { header: "*;q=1, identity;q=0", encoding: "gzip", code: 200 },
        { header: "gzip;q=0, identity;q=0", encoding: undefined, code: 406 },
      ]) {
        const response = await requestManifest(header);
        expect(response.statusCode).toBe(code);
        expect(response.headers["content-encoding"]).toBe(encoding);
        expect(response.headers.vary).toBe("Accept-Encoding");
        if (code === 200) {
          const bytes = response.bytes;
          expect((encoding === "gzip" ? gunzipSync(bytes) : bytes).toString()).toBe(
            snapshot.rawManifest,
          );
        }
      }
      const invalid = await requestManifest("gzip", "invalid-token");
      expect(invalid.statusCode).toBe(404);
      expect(invalid.headers["content-encoding"]).toBeUndefined();

      const workspaceDir = path.join(root, "download");
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl: server.gatewayUrl,
          environmentId: "environment",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "download", token, manifestRef: snapshot.manifestRef },
        }),
      ).resolves.toBe(snapshot.manifestRef);
      expect(await fs.readFile(path.join(workspaceDir, "input.txt"), "utf8")).toBe(
        "transfer content\n",
      );

      const snapshotFor = service.snapshot.bind(service);
      vi.spyOn(service, "snapshot").mockImplementation((authorization) => {
        const captured = snapshotFor(authorization);
        queueMicrotask(() => service.revoke("environment", token));
        return captured;
      });
      const revoked = await requestManifest("gzip");
      expect(revoked.statusCode).toBe(404);
      expect(revoked.headers["content-encoding"]).toBeUndefined();
    } finally {
      await service.closeAll();
      await server.close();
    }
  });
});
