import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import * as tar from "tar";
import { expect, it } from "vitest";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleArchiveManifest,
} from "../../shared/worker-bundle-archive.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";
import {
  buildId,
  useNodeBootstrapArtifactFixtures,
  version,
  write,
} from "./node-bootstrap-artifact.test-support.js";

const { fixture, createProvider } = useNodeBootstrapArtifactFixtures();

async function retainArchive(initial?: Awaited<ReturnType<typeof fixture>>) {
  const current = initial ?? (await fixture());
  const built = await current.provider.prepare();
  const builtBytes = await fs.readFile(built.tarballPath);
  // Distinct compressed bytes distinguish retained-archive reuse from a deterministic rebuild.
  const bytes = gzipSync(gunzipSync(builtBytes), { level: 1 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(sha256).not.toBe(built.tarballSha256);
  const archive = path.join(current.packageRoot, "node-runtime.tgz");
  await fs.writeFile(archive, bytes);
  await current.provider.close();
  return { ...current, built, builtBytes, bytes, sha256, archive };
}

async function rewriteArchive(
  root: string,
  archive: string,
  change: "extra entry" | "missing entry" | "permissions",
) {
  const manifest = await readWorkerBundleArchiveManifest(
    archive,
    DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  );
  const extracted = path.join(root, "archive-edit");
  await fs.mkdir(extracted);
  await tar.extract({ file: archive, cwd: extracted, chmod: true, processUmask: 0 });
  let files = manifest.map((entry) => entry.path);
  if (change === "extra entry") {
    await write(extracted, "package/dist/extra.js", "export const extra = true;");
    files.push("package/dist/extra.js");
  } else if (change === "missing entry") {
    files = files.filter((entry) => entry !== "package/dist/shared.js");
  } else {
    await fs.chmod(path.join(extracted, "package/dist/shared.js"), 0o777);
  }
  await tar.create(
    { file: archive, cwd: extracted, gzip: true, noMtime: true, portable: true },
    files,
  );
}

it("reuses image-owned bytes after restart without mutating the deployment archive", async () => {
  const { options, built, bytes, sha256, archive } = await retainArchive();
  const restarted = createProvider(options);
  const [artifact, concurrent] = await Promise.all([
    restarted.prepare(new AbortController().signal),
    restarted.prepare(),
  ]);
  expect(artifact.tarballSha256).toBe(process.platform === "win32" ? built.tarballSha256 : sha256);
  expect(artifact.tarballPath).not.toBe(archive);
  expect(concurrent).toBe(artifact);
  expect(await restarted.prepare()).toBe(artifact);
  const acceptedBytes = await fs.readFile(artifact.tarballPath);
  expect(await fs.readFile(archive)).toEqual(bytes);
  await fs.writeFile(archive, "image replaced after preparation");
  expect(await fs.readFile(artifact.tarballPath)).toEqual(acceptedBytes);
  await restarted.close();
  await expect(restarted.prepare()).rejects.toThrow("closed");
  await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(archive, "utf8")).toBe("image replaced after preparation");
});

it.each([
  "missing",
  "truncated",
  "oversized",
  "symlink",
  "extra entry",
  "missing entry",
  "permissions",
] as const)("rebuilds invalid %s input without mutating it", async (failure) => {
  const { root, options, built, builtBytes, bytes, archive } = await retainArchive();
  if (failure === "missing") {
    await fs.rm(archive);
  } else if (failure === "truncated") {
    await fs.writeFile(archive, bytes.subarray(0, bytes.length / 2));
  } else if (failure === "oversized") {
    // Sparse file exercises the transfer admission bound without allocating 512 MiB.
    await fs.truncate(archive, MAX_WORKER_BUNDLE_ARCHIVE_BYTES + 1);
  } else if (failure === "symlink") {
    const target = path.join(root, "image-archive.tgz");
    await fs.rename(archive, target);
    await fs.symlink(target, archive);
  } else {
    await rewriteArchive(root, archive, failure);
  }
  const before = await fs.lstat(archive).catch(() => undefined);
  const suppliedBytes = before && failure !== "oversized" ? await fs.readFile(archive) : undefined;
  const artifact = await createProvider(options).prepare();
  expect(artifact.tarballSha256).toBe(built.tarballSha256);
  expect(await fs.readFile(artifact.tarballPath)).toEqual(builtBytes);
  if (!before) {
    await expect(fs.access(archive)).rejects.toHaveProperty("code", "ENOENT");
  } else {
    const after = await fs.lstat(archive);
    expect(after).toMatchObject({ ino: before.ino, size: before.size });
    expect(after.isSymbolicLink()).toBe(before.isSymbolicLink());
    if (suppliedBytes) {
      expect(await fs.readFile(archive)).toEqual(suppliedBytes);
    }
  }
});

it("rebuilds duplicate image entries for concurrent consumers and cleans up on close", async () => {
  const { options, built, builtBytes, archive } = await retainArchive();
  const header = Buffer.alloc(512);
  new tar.Header({ path: "package/duplicate", type: "File", mode: 0o600, size: 0 }).encode(header);
  const invalidBytes = gzipSync(Buffer.concat([header, header, Buffer.alloc(1024)]));
  await fs.writeFile(archive, invalidBytes);
  const restarted = createProvider(options);
  const enrollment = new AbortController();
  try {
    const [artifact, concurrent] = await Promise.all([
      restarted.prepare(enrollment.signal),
      restarted.prepare(),
    ]);
    expect(concurrent).toBe(artifact);
    expect(artifact.tarballSha256).toBe(built.tarballSha256);
    expect(await fs.readFile(artifact.tarballPath)).toEqual(builtBytes);
    await restarted.close();
    await expect(fs.access(artifact.tarballPath)).rejects.toHaveProperty("code", "ENOENT");
    expect(await fs.readFile(archive)).toEqual(invalidBytes);
  } finally {
    enrollment.abort();
  }
});

it.each([
  { owner: "built runtime", relative: "dist/shared.js" },
  { owner: "selected plugin", relative: "dist/extensions/remote-runtime/index.js" },
])("rebuilds changed $owner bytes under the same version and build ID", async ({ relative }) => {
  const { root, packageRoot, options, bytes, archive, sha256 } = await retainArchive();
  await write(packageRoot, relative, 'export const answer = "changed-runtime";');
  const artifact = await createProvider(options).prepare();
  expect(artifact).toMatchObject({ buildId, openclawVersion: version });
  expect(artifact.tarballSha256).not.toBe(sha256);
  const installed = path.join(root, "updated-node");
  await fs.mkdir(installed);
  await tar.extract({ file: artifact.tarballPath, cwd: installed });
  const { stdout } = await promisify(execFile)(process.execPath, [
    path.join(installed, "package/openclaw.mjs"),
  ]);
  expect(stdout.trim()).toBe("local-ai:changed-runtime");
  expect(await fs.readFile(archive)).toEqual(bytes);
});

it("keeps both execution modes available with an image prepared for worker-turn", async () => {
  const current = await fixture();
  await write(current.packageRoot, "dist/entry.js", 'console.log("generic-node");');
  const workerOptions = { ...current.options, plugins: [] };
  const { built, sha256, archive, bytes } = await retainArchive({
    ...current,
    provider: createProvider(workerOptions),
  });
  const [worker, remote] = await Promise.all([
    createProvider(workerOptions).prepare(),
    createProvider(current.options).prepare(),
  ]);
  expect(worker.enabledPluginIds).toEqual([]);
  expect(remote.enabledPluginIds).toEqual(["remote-runtime"]);
  expect(worker.tarballSha256).toBe(process.platform === "win32" ? built.tarballSha256 : sha256);
  expect(remote.tarballSha256).not.toBe(worker.tarballSha256);
  expect(await fs.readFile(archive)).toEqual(bytes);
});

it("checks the running build before accepting a retained archive and rebuilds after upgrade", async () => {
  const { packageRoot, options, archive, bytes, sha256 } = await retainArchive();
  await write(packageRoot, "dist/build-info.json", { version, buildId: "next-build" });
  await expect(createProvider(options).prepare()).rejects.toThrow("running Gateway build");
  const upgraded = await createProvider({
    ...options,
    runningBuildId: "next-build",
  }).prepare();
  expect(upgraded).toMatchObject({ buildId: "next-build", openclawVersion: version });
  expect(upgraded.tarballSha256).not.toBe(sha256);
  expect(await fs.readFile(archive)).toEqual(bytes);
});
