import fs from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { withNodeWorkerTransferHttpRequest } from "../../node-host/node-worker-transfer-http.js";
import { nodeWorkspaceTransferManifestPath } from "../../worker/node-workspace-transfer-protocol.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "./node-workspace-transfer.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("negotiates gzip only for authorized manifests while retaining identity peers", async () => {
  const root = tempDirs.make("workspace-transfer-encoding-");
  const localPath = path.join(root, "source");
  const content = "transfer content\n";
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(localPath, "input.txt"), content);
  const service = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "transfers"),
    getOwner: () => transferOwner("session"),
  });
  const server = await startNodeWorkspaceTransferTestServer(service);
  try {
    const { snapshot, token } = await service.prepareSync({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      localPath,
      isAuthorized: () => true,
    });
    const requestManifest = async (header?: string, requestToken = token) =>
      await withNodeWorkerTransferHttpRequest(
        {
          gatewayUrl: server.gatewayUrl,
          routePath: nodeWorkspaceTransferManifestPath("environment", snapshot.manifestRef),
          method: "GET",
          token: requestToken,
          headers: header ? { "accept-encoding": header } : undefined,
        },
        async (response) => ({
          code: response.statusCode,
          encoding: response.headers["content-encoding"],
          vary: response.headers.vary,
          bytes: await buffer(response),
        }),
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
      expect(response).toMatchObject({ code, encoding, vary: "Accept-Encoding" });
      if (code === 200) {
        const bytes = response.bytes;
        expect((encoding === "gzip" ? gunzipSync(bytes) : bytes).toString()).toBe(
          snapshot.rawManifest,
        );
      }
    }
    const invalid = await requestManifest("gzip", "invalid-token");
    expect(invalid).toMatchObject({ code: 404, encoding: undefined });

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
    expect(await fs.readFile(path.join(workspaceDir, "input.txt"), "utf8")).toBe(content);

    const snapshotFor = service.snapshot.bind(service);
    vi.spyOn(service, "snapshot").mockImplementation((authorization) => {
      const captured = snapshotFor(authorization);
      queueMicrotask(() => {
        void service.revoke("environment", token);
      });
      return captured;
    });
    const revoked = await requestManifest("gzip");
    expect(revoked).toMatchObject({ code: 404, encoding: undefined });
  } finally {
    await service.closeAll();
    await server.close();
  }
});
