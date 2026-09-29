import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerBundleInstaller } from "../../node-host/node-worker-bundle-installer.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleDirectoryManifest,
} from "../../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../../shared/worker-bundle-hash.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { NODE_WORKER_BUNDLE_TRANSFER_PATH } from "../../worker/node-bundle-install-protocol.js";
import { createArtifactTransferHttpCallback } from "./artifact-transfer-http.js";
import { handleNodeWorkerBundleTransferHttpRequest } from "./node-worker-bundle-transfer-http.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";

describe("node worker bundle transfer", () => {
  let root: string;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let cleanupServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    root = tempDirs.make("openclaw-bundle-wire-");
  });

  afterEach(async () => {
    await cleanupServer?.();
    cleanupServer = undefined;
  });

  it("reports cumulative progress despite a throwing observer and rejects a second HTTP serve", async ({
    onTestFinished,
  }) => {
    const source = path.join(root, "source");
    const tarballPath = path.join(root, "bundle.tgz");
    await fs.mkdir(source, { recursive: true });
    const artifacts = ["github-exec-launcher.mjs", "worker.mjs", "workspace-rsync-receiver.mjs"];
    for (const artifact of artifacts) {
      await fs.writeFile(path.join(source, artifact), "export {};\n", { mode: 0o700 });
    }
    await fs.writeFile(
      path.join(source, "worker.mjs"),
      `/*${randomBytes(128 * 1024).toString("hex")}*/\nexport {};\n`,
    );
    const manifest = await readWorkerBundleDirectoryManifest({
      root: source,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });
    const bundleHash = hashWorkerBundleManifest(manifest);
    await tar.create({ cwd: source, file: tarballPath, gzip: true, noDirRecurse: true }, artifacts);
    const tarball = await fs.readFile(tarballPath);
    const service = createNodeWorkerBundleTransferService({
      generateToken: () => "A".repeat(43),
    });
    onTestFinished(() => service.closeAll());
    const node = createNodeWorkerBundleTestNode();
    const progress: number[] = [];
    const prepared = service.prepare({
      node,
      gatewayNamespace: "gateway-test",
      artifact: {
        install: "bundle",
        bundleHash,
        openclawVersion: "2026.8.1",
        protocolFeatures: [],
        tarballBytes: tarball.byteLength,
        tarballSha256: createHash("sha256").update(tarball).digest("hex"),
        tarballPath,
      },
      isAuthorized: () => true,
      onProgress: (servedBytes) => {
        progress.push(servedBytes);
        throw new Error("progress observer failed");
      },
    });
    const callback = createArtifactTransferHttpCallback(service);
    const served = createDeferredCore();
    const {
      listener: server,
      releaseListener,
      claim,
    } = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        http.createServer((req, res) => {
          void handleNodeWorkerBundleTransferHttpRequest({
            req,
            res,
            clientIp: "127.0.0.1",
            callback,
          })
            .then(() => served.resolve())
            .catch((error: unknown) => res.destroy(error as Error));
        }),
    });
    cleanupServer = async () => {
      try {
        await releaseListener();
      } finally {
        await claim.release();
        service.closeAll();
      }
    };
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const installer = new NodeWorkerBundleInstaller({ root: path.join(root, "node-host") });

    await expect(
      installer.ensure({
        input: prepared.input,
        gatewayUrl: `ws://127.0.0.1:${address.port}`,
      }),
    ).resolves.toEqual(prepared.input.build);
    await served.promise;
    const replay = await fetch(
      `http://127.0.0.1:${address.port}${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/${bundleHash}`,
      { headers: { authorization: `Bearer ${prepared.token}` } },
    );
    expect(replay.status).toBe(404);
    await expect(replay.json()).resolves.toEqual({ error: "not_found" });
    expect(progress.length).toBeGreaterThan(1);
    for (let index = 0; index < progress.length; index++) {
      expect(progress[index]).toBeGreaterThan(progress[index - 1] ?? 0);
    }
    expect(progress.at(-1)).toBe(tarball.byteLength);
    expect(service.authorize({ token: prepared.token, artifactKey: bundleHash })).toBeUndefined();
  });
});
