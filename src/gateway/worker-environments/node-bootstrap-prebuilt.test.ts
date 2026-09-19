import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
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

async function retainArchive(current: Awaited<ReturnType<typeof fixture>>) {
  const built = await current.provider.prepare();
  const builtBytes = await fs.readFile(built.tarballPath);
  // Distinct compressed bytes distinguish retained-archive reuse from a deterministic rebuild.
  const retainedBytes = gzipSync(gunzipSync(builtBytes), { level: 1 });
  const retainedHash = createHash("sha256").update(retainedBytes).digest("hex");
  expect(retainedHash).not.toBe(built.tarballSha256);
  const retainedPath = path.join(current.packageRoot, "node-runtime.tgz");
  await fs.writeFile(retainedPath, retainedBytes);
  await current.provider.close();
  return { built, builtBytes, retainedBytes, retainedHash, retainedPath };
}

async function rewriteArchive(
  root: string,
  retainedPath: string,
  change: "extra entry" | "missing entry" | "permissions",
) {
  const manifest = await readWorkerBundleArchiveManifest(
    retainedPath,
    DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  );
  const extracted = path.join(root, "archive-edit");
  await fs.mkdir(extracted);
  await tar.extract({ file: retainedPath, cwd: extracted, chmod: true, processUmask: 0 });
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
    { file: retainedPath, cwd: extracted, gzip: true, noMtime: true, portable: true },
    files,
  );
}

describe("prebuilt node bootstrap distribution", () => {
  it("reuses image-owned bytes after restart and pins a private copy until enrollment closes", async () => {
    const current = await fixture();
    const { built, retainedBytes, retainedHash, retainedPath } = await retainArchive(current);
    const restarted = createProvider(current.options);
    const enrollment = new AbortController();
    try {
      const [artifact, concurrent] = await Promise.all([
        restarted.prepare(enrollment.signal),
        restarted.prepare(),
      ]);
      expect(artifact.tarballSha256).toBe(
        process.platform === "win32" ? built.tarballSha256 : retainedHash,
      );
      expect(artifact.tarballPath).not.toBe(retainedPath);
      expect(concurrent).toBe(artifact);
      expect(await restarted.prepare()).toBe(artifact);
      const acceptedBytes = await fs.readFile(artifact.tarballPath);
      expect(await fs.readFile(retainedPath)).toEqual(retainedBytes);
      await fs.writeFile(retainedPath, "image replaced after preparation");
      expect(await fs.readFile(artifact.tarballPath)).toEqual(acceptedBytes);
      const closing = restarted.close();
      await expect(fs.access(artifact.tarballPath)).resolves.toBeUndefined();
      await expect(restarted.prepare()).rejects.toThrow("closed");
      enrollment.abort();
      await closing;
      await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(retainedPath, "utf8")).toBe("image replaced after preparation");
    } finally {
      enrollment.abort();
    }
  });

  it.each(["missing", "corrupt", "truncated", "oversized", "symlink"] as const)(
    "builds the canonical archive when deployment input is %s without changing that input",
    async (failure) => {
      const current = await fixture();
      const { built, builtBytes, retainedBytes, retainedPath } = await retainArchive(current);
      if (failure === "missing") {
        await fs.rm(retainedPath);
      } else if (failure === "corrupt") {
        await fs.writeFile(retainedPath, "not an archive");
      } else if (failure === "truncated") {
        await fs.writeFile(retainedPath, retainedBytes.subarray(0, retainedBytes.length / 2));
      } else if (failure === "oversized") {
        const handle = await fs.open(retainedPath, "w");
        try {
          // Sparse file exercises the transfer admission bound without allocating 512 MiB.
          await handle.truncate(MAX_WORKER_BUNDLE_ARCHIVE_BYTES + 1);
        } finally {
          await handle.close();
        }
      } else {
        const target = path.join(current.root, "image-archive.tgz");
        await fs.rename(retainedPath, target);
        await fs.symlink(target, retainedPath);
      }
      const before = await fs.lstat(retainedPath).catch(() => undefined);
      const suppliedBytes =
        before && failure !== "oversized" ? await fs.readFile(retainedPath) : undefined;
      const artifact = await createProvider(current.options).prepare();
      expect(artifact.tarballSha256).toBe(built.tarballSha256);
      expect(await fs.readFile(artifact.tarballPath)).toEqual(builtBytes);
      if (!before) {
        await expect(fs.access(retainedPath)).rejects.toHaveProperty("code", "ENOENT");
      } else {
        const after = await fs.lstat(retainedPath);
        expect([after.ino, after.size, after.isSymbolicLink()]).toEqual([
          before.ino,
          before.size,
          before.isSymbolicLink(),
        ]);
        if (suppliedBytes) {
          expect(await fs.readFile(retainedPath)).toEqual(suppliedBytes);
        }
      }
    },
  );

  it.each([
    { owner: "built runtime", relative: "dist/shared.js" },
    { owner: "selected plugin", relative: "dist/extensions/remote-runtime/index.js" },
  ])("rebuilds changed $owner bytes under the same version and build ID", async ({ relative }) => {
    const current = await fixture();
    const { retainedBytes, retainedPath, retainedHash } = await retainArchive(current);
    await write(current.packageRoot, relative, 'export const answer = "changed-runtime";');
    const artifact = await createProvider(current.options).prepare();
    expect(artifact).toMatchObject({ buildId, openclawVersion: version });
    expect(artifact.tarballSha256).not.toBe(retainedHash);
    const installed = path.join(current.root, "updated-node");
    await fs.mkdir(installed);
    await tar.extract({ file: artifact.tarballPath, cwd: installed });
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(installed, "package/openclaw.mjs"),
    ]);
    expect(stdout.trim()).toBe("local-ai:changed-runtime");
    expect(await fs.readFile(retainedPath)).toEqual(retainedBytes);
  });

  it.each(["extra entry", "missing entry", "permissions"] as const)(
    "rebuilds a prebuilt archive with mismatched %s",
    async (change) => {
      const current = await fixture();
      const { built, builtBytes, retainedPath } = await retainArchive(current);
      await rewriteArchive(current.root, retainedPath, change);
      const mismatchedBytes = await fs.readFile(retainedPath);
      const artifact = await createProvider(current.options).prepare();
      expect(artifact.tarballSha256).toBe(built.tarballSha256);
      expect(await fs.readFile(artifact.tarballPath)).toEqual(builtBytes);
      expect(await fs.readFile(retainedPath)).toEqual(mismatchedBytes);
    },
  );

  it("rebuilds duplicate image entries for concurrent consumers and cleans up after enrollment", async () => {
    const current = await fixture();
    const { built, builtBytes, retainedPath } = await retainArchive(current);
    const header = Buffer.alloc(512);
    new tar.Header({ path: "package/duplicate", type: "File", mode: 0o600, size: 0 }).encode(
      header,
    );
    const invalidBytes = gzipSync(Buffer.concat([header, header, Buffer.alloc(1024)]));
    await fs.writeFile(retainedPath, invalidBytes);
    const restarted = createProvider(current.options);
    const enrollment = new AbortController();
    try {
      const [artifact, concurrent] = await Promise.all([
        restarted.prepare(enrollment.signal),
        restarted.prepare(),
      ]);
      expect(concurrent).toBe(artifact);
      expect(artifact.tarballSha256).toBe(built.tarballSha256);
      expect(await fs.readFile(artifact.tarballPath)).toEqual(builtBytes);
      const closing = restarted.close();
      await expect(fs.access(artifact.tarballPath)).resolves.toBeUndefined();
      enrollment.abort();
      await closing;
      await expect(fs.access(artifact.tarballPath)).rejects.toHaveProperty("code", "ENOENT");
      expect(await fs.readFile(retainedPath)).toEqual(invalidBytes);
    } finally {
      enrollment.abort();
    }
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "keeps both execution modes available with an image prepared for %s",
    async (retainedMode) => {
      const current = await fixture();
      await write(current.packageRoot, "dist/entry.js", 'console.log("generic-node");');
      const workerOptions = { ...current.options, plugins: [] };
      const owner =
        retainedMode === "worker-turn" ? createProvider(workerOptions) : current.provider;
      const { built, retainedHash, retainedPath, retainedBytes } = await retainArchive({
        ...current,
        provider: owner,
      });
      const [worker, remote] = await Promise.all([
        createProvider(workerOptions).prepare(),
        createProvider(current.options).prepare(),
      ]);
      expect(worker.enabledPluginIds).toEqual([]);
      expect(remote.enabledPluginIds).toEqual(["remote-runtime"]);
      const matching = retainedMode === "worker-turn" ? worker : remote;
      const different = retainedMode === "worker-turn" ? remote : worker;
      expect(matching.tarballSha256).toBe(
        process.platform === "win32" ? built.tarballSha256 : retainedHash,
      );
      expect(different.tarballSha256).not.toBe(matching.tarballSha256);
      expect(await fs.readFile(retainedPath)).toEqual(retainedBytes);
    },
  );

  it("cancels one consumer while another retains preparation and leaves the image archive intact", async () => {
    const current = await fixture();
    const { built, retainedPath, retainedBytes, retainedHash } = await retainArchive(current);
    const restarted = createProvider(current.options);
    const cancelled = new AbortController();
    const pending = restarted.prepare(cancelled.signal);
    const surviving = restarted.prepare();
    const reason = new Error("enrollment cancelled");
    cancelled.abort(reason);
    await expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason });
    const artifact = await surviving;
    expect(artifact.tarballSha256).toBe(
      process.platform === "win32" ? built.tarballSha256 : retainedHash,
    );
    await restarted.close();
    await expect(fs.access(artifact.tarballPath)).rejects.toHaveProperty("code", "ENOENT");
    expect(await fs.readFile(retainedPath)).toEqual(retainedBytes);
  });

  it("checks the running build before accepting a retained archive and rebuilds after upgrade", async () => {
    const current = await fixture();
    const { retainedPath, retainedBytes, retainedHash } = await retainArchive(current);
    await write(current.packageRoot, "dist/build-info.json", { version, buildId: "next-build" });
    await expect(createProvider(current.options).prepare()).rejects.toThrow(
      "running Gateway build",
    );
    const upgraded = await createProvider({
      ...current.options,
      runningBuildId: "next-build",
    }).prepare();
    expect(upgraded).toMatchObject({ buildId: "next-build", openclawVersion: version });
    expect(upgraded.tarballSha256).not.toBe(retainedHash);
    expect(await fs.readFile(retainedPath)).toEqual(retainedBytes);
  });
});
