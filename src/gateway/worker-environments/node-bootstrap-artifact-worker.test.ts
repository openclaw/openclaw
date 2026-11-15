import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import * as distImports from "../../../scripts/lib/package-dist-imports.mjs";
import * as bundleArchives from "../../shared/worker-bundle-archive.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../../shared/worker-bundle-hash.js";
import { createWorkerBundleProducer } from "./bundle.js";
import { useNodeBootstrapArtifactFixtures, write } from "./node-bootstrap-artifact.test-support.js";

// mock-isolation: preserve archive I/O while guarding compression on this thread only.
vi.mock("tar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tar")>();
  return { ...actual, create: vi.fn(actual.create) };
});

const { fixture, tempDirs } = useNodeBootstrapArtifactFixtures();
const forbidCallerWork = () => {
  throw new Error("Artifact work must run off the caller thread");
};
afterEach(() => {
  vi.mocked(tar.create).mockRestore();
  vi.restoreAllMocks();
});

it("prepares cold, cached, and packaged worker archives off the caller thread", async () => {
  const root = tempDirs.make("worker-artifact-thread-");
  const packageRoot = path.join(root, "source");
  const cacheDir = path.join(root, "cache");
  for (const artifact of WORKER_BUNDLE_ARTIFACT_PATHS) {
    await write(packageRoot, `dist/worker/${artifact}`, "export {};\n");
  }
  vi.mocked(tar.create).mockImplementation(forbidCallerWork);
  vi.spyOn(bundleArchives, "readWorkerBundleArchiveManifest").mockImplementation(forbidCallerWork);
  const owner = createWorkerBundleProducer({ packageRoot, cacheDir, openclawVersion: " 1.2.3 " });
  const first = await owner.prepare();
  expect(first.openclawVersion).toBe("1.2.3");
  const cached = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();

  const installedRoot = path.join(root, "installed");
  const packagedArchive = path.join(
    installedRoot,
    "dist/worker-artifacts",
    `${first.bundleHash}.tar.gz`,
  );
  await fs.mkdir(path.dirname(packagedArchive), { recursive: true });
  await fs.copyFile(first.tarballPath, packagedArchive);
  const packaged = await createWorkerBundleProducer({ packageRoot: installedRoot }).prepare();
  expect([cached.bundleHash, packaged.bundleHash]).toEqual([first.bundleHash, first.bundleHash]);
});

it("prepares an artifact without parsing imports on the caller thread", async () => {
  const { provider } = await fixture();
  vi.spyOn(distImports, "collectPackageDistImports").mockImplementation(forbidCallerWork);
  await expect(provider.prepare()).resolves.toHaveProperty("tarballPath");
});
