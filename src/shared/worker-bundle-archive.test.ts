import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { workerBundleArchiveEntrypoint } from "./worker-bundle-archive-runtime.test-support.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS as limits,
  extractWorkerBundleArchive,
  readWorkerBundleArchiveManifest,
  readWorkerBundleDirectoryManifest,
} from "./worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "./worker-bundle-hash.js";

describe("worker bundle archive", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string, source: string, archive: string, destination: string;

  beforeEach(() => {
    root = tempDirs.make("openclaw-bundle-archive-");
    source = path.join(root, "source");
    archive = path.join(root, "bundle.tgz");
    destination = path.join(root, "destination");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function artifact(name: string, contents: string | Buffer, mode?: number) {
    const file = path.join(source, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    if (mode !== undefined) {
      await fs.chmod(file, mode);
    }
  }
  const pack = (files: string[]) =>
    tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, files);
  const archiveManifest = () => readWorkerBundleArchiveManifest(archive, limits);
  const directoryManifest = (
    options: Partial<Parameters<typeof readWorkerBundleDirectoryManifest>[0]> = {},
  ) => readWorkerBundleDirectoryManifest({ root: source, limits, ...options });
  const directoryHash = async (directory = source) =>
    hashWorkerBundleManifest(await directoryManifest({ root: directory }));
  const extract = (expectedBundleHash: string) =>
    extractWorkerBundleArchive({ tarballPath: archive, destination, expectedBundleHash, limits });
  const entry = (entryPath: string, contents: string) => ({
    path: entryPath,
    mode: 0o700,
    size: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex"),
  });

  it("extracts only a manifest-identical regular-file bundle", async () => {
    await artifact("openclaw.mjs", "#!/usr/bin/env node\n", 0o700);
    await artifact("dist/worker.js", "export const worker = true;\n", 0o600);
    await artifact("dist/Upper.js", "export const upper = true;\n", 0o600);
    const bundleHash = await directoryHash();
    await pack(["openclaw.mjs", "dist/worker.js", "dist/Upper.js"]);
    await expect(extract("f".repeat(64))).rejects.toThrow("archive manifest does not match");
    await extract(bundleHash);

    expect(await directoryHash(destination)).toBe(bundleHash);
  });

  it("rejects archive links before extraction", async () => {
    await artifact("target", "target");
    await fs.symlink("target", path.join(source, "openclaw.mjs"));
    await pack(["openclaw.mjs"]);

    await expect(archiveManifest()).rejects.toThrow("Invalid worker bundle tar entry");
  });

  it.each([
    ["duplicate paths", ["worker.mjs", "worker.mjs"], {}, "Duplicate"],
    ["unsafe paths", ["../worker.mjs"], {}, "Invalid worker bundle archive path"],
    ["entry limit", ["worker.mjs", "other.mjs"], { maxEntries: 1 }, "entry limit"],
    ["byte limit", ["worker.mjs"], { maxExpandedBytes: 1 }, "expanded byte limit"],
  ] as const)(
    "rejects %s and cancels the remaining input",
    async (_name, paths, overrides, error) => {
      const chunks: Buffer[] = [];
      for (const entryPath of paths) {
        const header = Buffer.alloc(512);
        new tar.Header({ path: entryPath, type: "File", mode: 0o600, size: 2 }).encode(header);
        chunks.push(header, Buffer.from("ok"), Buffer.alloc(510));
      }
      const tail = randomBytes(1024 * 1024);
      const tailHeader = Buffer.alloc(512);
      new tar.Header({ path: "tail", type: "File", mode: 0o600, size: tail.length }).encode(
        tailHeader,
      );
      const bytes = Buffer.concat([...chunks, tailHeader, tail, Buffer.alloc(1024)]);
      const scenarioLimits = { maxEntries: 10, maxExpandedBytes: bytes.length, ...overrides };
      // Callback exceptions used to escape the promise and terminate the process.
      const archiveUrl = resolveRuntimeWorkerUrl(workerBundleArchiveEntrypoint);
      const probe = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const createReadStream = fs.createReadStream;
      let input;
      // Exercise header-boundary cancellation without a transfer-sized fixture.
      fs.createReadStream = (file, options) =>
        (input = createReadStream(file, { ...options, highWaterMark: 1024 }));
      syncBuiltinESMExports();
      const { readWorkerBundleArchiveManifest } = await import(${JSON.stringify(archiveUrl.href)});
      await assert.rejects(
        readWorkerBundleArchiveManifest(process.argv[1], ${JSON.stringify(scenarioLimits)}),
        { message: new RegExp(${JSON.stringify(error)}) },
      );
      assert.equal(input.closed, true);
      assert.ok(input.bytesRead < fs.statSync(process.argv[1]).size);
    `;
      for (const compressed of [false, true]) {
        const invalidArchive = path.join(root, compressed ? "invalid.tgz" : "invalid.tar");
        await fs.writeFile(invalidArchive, compressed ? gzipSync(bytes) : bytes);
        const result = await promisify(execFile)(
          process.execPath,
          [
            ...resolveRuntimeWorkerArgv(archiveUrl).slice(0, -1),
            "--input-type=module",
            "--eval",
            probe,
            invalidArchive,
          ],
          { timeout: 10_000 },
        );
        expect(result.stderr).toBe("");
      }
    },
  );

  it("preserves archive ratio admission with a highly compressible prefix", async () => {
    await artifact("zeros", Buffer.alloc(5 * 1024 * 1024));
    await artifact("tail", randomBytes(2 * 1024 * 1024));
    await pack(["zeros", "tail"]);

    const manifest = await archiveManifest();
    expect(manifest.map(({ path: entryPath, size }) => ({ path: entryPath, size }))).toEqual([
      { path: "tail", size: 2 * 1024 * 1024 },
      { path: "zeros", size: 5 * 1024 * 1024 },
    ]);
  });

  it.each(["replacement", "oversized", "symlink"] as const)(
    "handles a %s swapped in after directory entry inspection",
    async (kind) => {
      const filePath = path.join(source, "worker.mjs");
      const replacement = path.join(root, "replacement");
      const contents = "export const worker = true;\n";
      await artifact("worker.mjs", "old", 0o600);
      if (kind === "symlink") {
        const outside = path.join(root, "outside");
        await fs.writeFile(outside, contents);
        await fs.symlink(outside, replacement);
      } else {
        await fs.writeFile(replacement, contents, { mode: 0o700 });
      }
      const lstat = fs.lstat.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stats = await lstat(...args);
        if (!replaced && String(args[0]) === filePath) {
          replaced = true;
          await fs.rename(replacement, filePath);
        }
        return stats;
      });

      const manifest = directoryManifest({
        limits: { maxEntries: 1, maxExpandedBytes: kind === "oversized" ? 3 : 1024 },
      });
      if (kind === "replacement") {
        await expect(manifest).resolves.toEqual([entry("worker.mjs", contents)]);
      } else {
        await expect(manifest).rejects.toThrow(
          kind === "oversized" ? "directory exceeds its limits" : /symbolic link|symlink/iu,
        );
      }
      expect(replaced).toBe(true);
    },
  );

  it("retains hardlinked ~/worker.mjs and ignores directories and the install receipt in file limits", async () => {
    const relativePath = "~/worker.mjs";
    const original = path.join(root, "worker.mjs");
    const contents = "export {};\n";
    await fs.mkdir(path.join(source, "empty"), { recursive: true });
    await fs.mkdir(path.dirname(path.join(source, relativePath)), { recursive: true });
    await fs.writeFile(original, contents, { mode: 0o700 });
    await fs.link(original, path.join(source, relativePath));
    await fs.writeFile(path.join(source, "bootstrap-receipt.json"), "{}\n");

    await expect(
      directoryManifest({
        limits: { maxEntries: 1, maxExpandedBytes: Buffer.byteLength(contents) },
        ignoreTopLevel: new Set(["bootstrap-receipt.json"]),
      }),
    ).resolves.toEqual([entry(relativePath, contents)]);
  });

  it("preserves the v1 bundle hash when Windows cannot retain Unix artifact modes", async () => {
    await artifact("worker.mjs", "export {};\n", 0o700);
    await pack(["worker.mjs"]);
    const bundleHash = hashWorkerBundleManifest(await archiveManifest());
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await expect(extract(bundleHash)).resolves.toBeUndefined();
    await fs.chmod(path.join(destination, "worker.mjs"), 0o666);
    expect(await directoryHash(destination)).toBe(bundleHash);
  });
});
