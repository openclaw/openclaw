import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerBundleInstaller } from "../../node-host/node-worker-bundle-installer.js";
import { buildBundleFixture } from "../../node-host/node-worker-bundle-installer.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { NODE_WORKER_BUNDLE_TRANSFER_PATH } from "../../worker/node-bundle-install-protocol.js";
import { classifyNodeWorkerBundleTransferPath } from "../gateway-http-route-contracts.js";
import {
  createArtifactTransferHttpCallback,
  handleArtifactTransferHttpRequest,
} from "./artifact-transfer-http.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("streams despite observer errors and rejects revoked downloads", async ({ onTestFinished }) => {
  const root = tempDirs.make("openclaw-bundle-wire-");
  const { archive, input } = await buildBundleFixture(root, {
    workerSource: `/*${randomBytes(128 * 1024).toString("hex")}*/\nexport {};\n`,
  });
  const { bundleHash } = input.build;
  const tarballPath = path.join(root, "bundle.tgz");
  await fs.writeFile(tarballPath, archive);
  const service = createNodeWorkerBundleTransferService({ generateToken: () => "A".repeat(43) });
  onTestFinished(() => service.closeAll());
  const progress: number[] = [];
  const prepared = service.prepare({
    gatewayNamespace: "gateway-test",
    artifact: {
      install: "bundle",
      ...input.build,
      tarballBytes: archive.byteLength,
      tarballSha256: input.archive.sha256,
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
  const { releaseListener, claim } = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((req, res) => {
        void handleArtifactTransferHttpRequest({
          classifyPath: classifyNodeWorkerBundleTransferPath,
          routePrefix: `${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/`,
          req,
          res,
          clientIp: "127.0.0.1",
          callback,
        })
          .then(() => served.resolve())
          .catch((error: unknown) => res.destroy(error as Error));
      }),
  });
  onTestFinished(() => runQaGatewayFixture(releaseListener, () => claim.release()));
  const installer = new NodeWorkerBundleInstaller({ root: path.join(root, "node-host") });

  await expect(
    installer.ensure({ input: prepared.input, gatewayUrl: `ws://127.0.0.1:${claim.port}` }),
  ).resolves.toEqual(prepared.input.build);
  await served.promise;
  service.revoke(prepared.token);
  const replay = await fetch(
    `http://127.0.0.1:${claim.port}${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/${bundleHash}`,
    { headers: { authorization: `Bearer ${prepared.token}` } },
  );
  expect(replay.status).toBe(404);
  await expect(replay.json()).resolves.toEqual({ error: "not_found" });
  expect(progress.length).toBeGreaterThan(1);
  expect(progress.every((bytes, index) => bytes > (progress[index - 1] ?? 0))).toBe(true);
  expect(progress.at(-1)).toBe(archive.byteLength);
});
