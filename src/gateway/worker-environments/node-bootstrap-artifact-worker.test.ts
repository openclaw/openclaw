import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import * as distImports from "../../../scripts/lib/package-dist-imports.mjs";
import * as bundleArchives from "../../shared/worker-bundle-archive.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../../shared/worker-bundle-hash.js";
import { createWorkerBundleProducer } from "./bundle.js";
import {
  buildId,
  useNodeBootstrapArtifactFixtures,
  version,
  write,
} from "./node-bootstrap-artifact.test-support.js";

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
  const contents = "export const worker = 'isolated';\n";
  for (const artifact of WORKER_BUNDLE_ARTIFACT_PATHS) {
    await write(packageRoot, `dist/worker/${artifact}`, contents);
  }
  const compression = vi.mocked(tar.create).mockImplementation(forbidCallerWork);
  const parsing = vi
    .spyOn(bundleArchives, "readWorkerBundleArchiveManifest")
    .mockImplementation(forbidCallerWork);
  const owner = createWorkerBundleProducer({
    packageRoot,
    cacheDir,
    openclawVersion: " 1.2.3 ",
    protocolFeatures: ["resume", "admission", "resume"],
  });
  const first = await owner.prepare();
  expect(await owner.prepare()).toBe(first);
  expect(first).toMatchObject({
    openclawVersion: "1.2.3",
    protocolFeatures: ["admission", "resume"],
  });
  const cached = await createWorkerBundleProducer({ packageRoot, cacheDir }).prepare();
  expect(cached.tarballSha256).toBe(first.tarballSha256);

  const installedRoot = path.join(root, "installed");
  const packagedArchive = path.join(
    installedRoot,
    "dist/worker-artifacts",
    `${first.bundleHash}.tar.gz`,
  );
  await fs.mkdir(path.dirname(packagedArchive), { recursive: true });
  await fs.copyFile(first.tarballPath, packagedArchive);
  const packaged = await createWorkerBundleProducer({ packageRoot: installedRoot }).prepare();
  expect(packaged).toMatchObject({
    bundleHash: first.bundleHash,
    tarballPath: packagedArchive,
    tarballSha256: first.tarballSha256,
  });
  expect(compression).not.toHaveBeenCalled();
  expect(parsing).not.toHaveBeenCalled();

  const bytes = await fs.readFile(packaged.tarballPath);
  expect(bytes.length).toBe(packaged.tarballBytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(packaged.tarballSha256);
  const extracted = path.join(root, "extracted");
  await fs.mkdir(extracted);
  await tar.extract({ file: packaged.tarballPath, cwd: extracted });
  expect(await fs.readFile(path.join(extracted, "worker.mjs"), "utf8")).toBe(contents);
});

it("verifies and shares an artifact without parsing imports on the caller thread", async () => {
  const { packageRoot, provider } = await fixture();
  const parser = vi
    .spyOn(distImports, "collectPackageDistImports")
    .mockImplementation(forbidCallerWork);
  await write(packageRoot, "dist/build-info.json", { version, buildId: "stale" });
  await expect(provider.prepare()).rejects.toThrow("running Gateway build");
  await write(packageRoot, "dist/build-info.json", { version, buildId });
  const enrollment = new AbortController();
  const first = provider.prepare(enrollment.signal);
  try {
    const cancelled = new AbortController();
    const other = provider.prepare(cancelled.signal);
    cancelled.abort(new Error("enrollment cancelled"));
    await expect(other).rejects.toMatchObject({ name: "AbortError" });
    const artifact = await first;
    expect(await provider.prepare()).toBe(artifact);
    expect(parser).not.toHaveBeenCalled();
    const bytes = await fs.readFile(artifact.tarballPath);
    expect(bytes.length).toBe(artifact.tarballBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.tarballSha256);
    // Preparation signals cancel waiters; close owns the completed archive's lifetime.
    await provider.close();
    await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    enrollment.abort();
    await first.catch(() => undefined);
  }
});
