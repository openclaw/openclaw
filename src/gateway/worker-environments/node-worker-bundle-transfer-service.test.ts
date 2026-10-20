import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ArtifactTransferBusyError } from "./artifact-transfer-service.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = async (options: { isAuthorized?: () => boolean; signal?: AbortSignal } = {}) => {
  const root = tempDirs.make("openclaw-bundle-transfer-");
  await fs.writeFile(path.join(root, "bundle.tgz"), "bundle");
  const service = createNodeWorkerBundleTransferService({
    now: () => 1_000,
    generateToken: () => "A".repeat(43),
  });
  const prepared = service.prepare({
    gatewayNamespace: "gateway-test",
    artifact: {
      install: "bundle",
      bundleHash: "a".repeat(64),
      openclawVersion: "2026.8.1",
      protocolFeatures: [],
      tarballBytes: 6,
      tarballSha256: "b".repeat(64),
      tarballPath: path.join(root, "bundle.tgz"),
    },
    isAuthorized: () => true,
    ...options,
  });
  return {
    service,
    request: { token: prepared.token, artifactKey: prepared.input.build.bundleHash },
  };
};

it("binds one exact archive download to live node authority", async () => {
  let authorized = true;
  const { service, request } = await fixture({ isAuthorized: () => authorized });
  const admission = service.authorize(request);
  expect(admission).toBeDefined();
  expect(() => service.authorize(request)).toThrow(ArtifactTransferBusyError);
  const file = await service.openFile(admission!);
  try {
    expect(file).toMatchObject({ bytes: 6, sha256: "b".repeat(64) });
    await expect(file!.handle.readFile("utf8")).resolves.toBe("bundle");
  } finally {
    await file?.handle.close();
  }

  authorized = false;
  expect(service.isAuthorizationCurrent(admission!)).toBe(false);
  service.revoke(admission!);
  expect(service.authorizationSignal(admission!).aborted).toBe(true);
});

it("rejects mismatched routes and revoked owner signals", async () => {
  const owner = new AbortController();
  const { service, request } = await fixture({ signal: owner.signal });
  expect(service.authorize({ ...request, artifactKey: "c".repeat(64) })).toBeUndefined();
  owner.abort();
  expect(service.authorize(request)).toBeUndefined();
});

it("permits 256 serial resume serves and revokes the exhausted grant", async () => {
  const { service, request } = await fixture();
  try {
    for (let serve = 0; serve < 256; serve++) {
      const admission = service.authorize(request);
      expect(admission).toBeDefined();
      service.finish(admission!);
      expect(service.authorizationSignal(admission!).aborted).toBe(true);
    }
    expect(service.authorize(request)).toBeUndefined();
  } finally {
    service.closeAll();
  }
});
