import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import * as commandRuntime from "../../process/exec.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import {
  withStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await drainGlobalSingletonLifecycleState();
});

const manifestRef = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;

async function stagedFixture(
  fileCount = 64,
  options: { largeFileBytes?: number; objectFormat?: "sha1" | "sha256" } = {},
) {
  const root = await fs.realpath(tempDirs.make("workspace-staged-reads-"));
  const repository = path.join(root, "repository");
  const input = path.join(root, "input");
  await Promise.all([fs.mkdir(repository), fs.mkdir(input)]);
  if (options.objectFormat === "sha256") {
    const initialized = await commandRuntime.runCommandWithTimeout(
      ["git", "-C", repository, "init", "--quiet", "--template=", "--object-format=sha256"],
      { timeoutMs: 10_000 },
    );
    expect(initialized.code, initialized.stderr).toBe(0);
  }
  const files = new Map<string, Buffer>();
  for (let index = 0; index < fileCount; index++) {
    files.set(`file-${String(index).padStart(3, "0")}.txt`, Buffer.from(`payload ${index}\n`));
  }
  const binaryPath = process.platform === "win32" ? "binary.bin" : "binary\nname.bin";
  files.set(binaryPath, Buffer.from([0, 10, 255, 13, 10, 0, 65]));
  files.set("executable.sh", Buffer.from("#!/bin/sh\nexit 0\n"));
  if (options.largeFileBytes) {
    files.set("large.bin", Buffer.alloc(options.largeFileBytes, 0x5a));
  }
  const entries: WorkerWorkspaceManifestEntry[] = [];
  for (const [entryPath, content] of files) {
    const target = path.join(input, entryPath);
    await fs.writeFile(target, content, { mode: entryPath === "executable.sh" ? 0o755 : 0o644 });
    const mode = (await fs.stat(target)).mode & 0o111 ? 0o755 : 0o644;
    entries.push({
      path: entryPath,
      type: "file",
      mode,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  if (process.platform !== "win32") {
    await fs.symlink(binaryPath, path.join(input, "current-link"));
    entries.push({ path: "current-link", type: "symlink", mode: 0o777, target: binaryPath });
  }
  const baseManifestRaw = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit: null,
    entries: [],
  });
  const currentManifestRaw = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit: null,
    entries,
  });
  const stagedResultRef = workerWorkspaceResultRef("read-batch");
  await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root: repository,
    stagingRoot: input,
    stagedResultRef,
    baseManifestRaw,
    currentManifestRaw,
    baseManifestRef: manifestRef(baseManifestRaw),
    currentManifestRef: manifestRef(currentManifestRaw),
  });
  return { repository, stagedResultRef, files, entries, binaryPath };
}

it.each([
  { fileCount: 64, maxReads: 4, largeFileBytes: 0, objectFormat: "sha1" as const },
  { fileCount: 300, maxReads: 6, largeFileBytes: 0, objectFormat: "sha1" as const },
  { fileCount: 0, maxReads: 4, largeFileBytes: 9 * 1024 * 1024, objectFormat: "sha1" as const },
  { fileCount: 0, maxReads: 4, largeFileBytes: 0, objectFormat: "sha256" as const },
])(
  "materializes $fileCount files with $largeFileBytes large-file bytes in $objectFormat using bounded Git reads",
  async ({ fileCount, maxReads, ...fixtureOptions }) => {
    const fixture = await stagedFixture(fileCount, fixtureOptions);
    const gitReads: string[][] = [];
    const runBuffered = commandRuntime.runCommandBuffered;
    vi.spyOn(commandRuntime, "runCommandBuffered").mockImplementation(async (argv, options) => {
      if (argv[argv.indexOf("-C") + 1] === fixture.repository) {
        gitReads.push(argv.slice(argv.indexOf("-C") + 2, argv.indexOf("-C") + 4));
      }
      return await runBuffered(argv, options);
    });
    const materialized: string[] = [];
    const writeFile = fs.writeFile.bind(fs);
    const symlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string") {
        materialized.push(args[0]);
      }
      return await writeFile(...args);
    });
    vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
      materialized.push(String(args[1]));
      return await symlink(...args);
    });
    let stagingRoot = "";
    await withStagedWorkerWorkspaceResult(
      { root: fixture.repository, stagedResultRef: fixture.stagedResultRef },
      async (snapshot) => {
        stagingRoot = snapshot.stagingRoot;
        for (const entry of snapshot.changedEntries) {
          const target = path.join(stagingRoot, entry.path);
          if (entry.type === "symlink") {
            expect(await fs.readlink(target)).toBe(entry.target);
          } else {
            // Node compares Buffer bytes without Vitest's per-byte object traversal.
            assert.deepStrictEqual(await fs.readFile(target), fixture.files.get(entry.path));
            if (process.platform !== "win32") {
              expect((await fs.stat(target)).mode & 0o777).toBe(entry.mode);
            }
          }
        }
        expect(
          materialized.filter((target) => target.startsWith(stagingRoot + path.sep)).toSorted(),
        ).toEqual(
          snapshot.changedEntries.map((entry) => path.join(stagingRoot, entry.path)).toSorted(),
        );
      },
    );
    await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      gitReads.length,
      JSON.stringify({ entries: fixture.entries.length, gitReads }),
    ).toBeLessThanOrEqual(maxReads);
  },
);

it.each(["oid", "type", "size", "digest", "truncated", "trailing"] as const)(
  "rejects a batch with invalid %s before writing staged files and cleans its temporary directory",
  async (corruption) => {
    const fixture = await stagedFixture(0);
    const runBuffered = commandRuntime.runCommandBuffered;
    let corrupted = 0;
    vi.spyOn(commandRuntime, "runCommandBuffered").mockImplementation(async (argv, options) => {
      const result = await runBuffered(argv, options);
      if (argv[argv.indexOf("-C") + 1] !== fixture.repository || !argv.includes("--batch")) {
        return result;
      }
      corrupted++;
      const bytes = Buffer.from(result.stdout);
      const headerEnd = bytes.indexOf(0x0a);
      expect(headerEnd).toBeGreaterThan(0);
      let stdout = bytes;
      switch (corruption) {
        case "oid":
          bytes[0] = bytes[0] === 0x30 ? 0x31 : 0x30;
          break;
        case "type":
          bytes.write("tree", bytes.indexOf(" blob ") + 1);
          break;
        case "size":
          stdout = Buffer.concat([
            Buffer.from(bytes.subarray(0, headerEnd).toString("utf8").replace(/\d+$/u, "0")),
            bytes.subarray(headerEnd),
          ]);
          break;
        case "digest":
          bytes[headerEnd + 1] = bytes[headerEnd + 1]! ^ 0xff;
          break;
        case "truncated":
          stdout = bytes.subarray(0, -1);
          break;
        case "trailing":
          stdout = Buffer.concat([bytes, Buffer.from([0])]);
          break;
      }
      return { ...result, stdout };
    });
    const temporary = vi.spyOn(fs, "mkdtemp");
    const writes = vi.spyOn(fs, "writeFile");
    const links = vi.spyOn(fs, "symlink");
    const use = vi.fn(async () => {});
    await expect(
      withStagedWorkerWorkspaceResult(
        { root: fixture.repository, stagedResultRef: fixture.stagedResultRef },
        use,
      ),
    ).rejects.toThrow("payload");
    expect(corrupted).toBe(1);
    expect(use).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(links).not.toHaveBeenCalled();
    expect(temporary).toHaveBeenCalledOnce();
    const created = temporary.mock.results[0];
    if (created?.type !== "return") {
      throw new Error("Staging did not create its temporary directory");
    }
    await expect(fs.stat(await created.value)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.skipIf(process.platform === "win32")(
  "authenticates symlink blobs before creating links",
  async () => {
    const fixture = await stagedFixture(0);
    const runBuffered = commandRuntime.runCommandBuffered;
    let corrupted = 0;
    vi.spyOn(commandRuntime, "runCommandBuffered").mockImplementation(async (argv, options) => {
      const result = await runBuffered(argv, options);
      if (argv[argv.indexOf("-C") + 1] !== fixture.repository || !argv.includes("--batch")) {
        return result;
      }
      const stdout = Buffer.from(result.stdout);
      const target = stdout.indexOf(fixture.binaryPath);
      expect(target).toBeGreaterThan(0);
      stdout[target] = stdout[target]! ^ 1;
      corrupted++;
      return { ...result, stdout };
    });
    const links = vi.spyOn(fs, "symlink");
    await expect(
      withStagedWorkerWorkspaceResult(
        { root: fixture.repository, stagedResultRef: fixture.stagedResultRef },
        async () => {},
      ),
    ).rejects.toThrow("payload is invalid: current-link");
    expect(corrupted).toBe(1);
    expect(links).not.toHaveBeenCalled();
  },
);

it("authenticates the singleton blob returned by checkpoint previews", async () => {
  const fixture = await stagedFixture(0);
  const runBuffered = commandRuntime.runCommandBuffered;
  let corrupted = 0;
  vi.spyOn(commandRuntime, "runCommandBuffered").mockImplementation(async (argv, options) => {
    const result = await runBuffered(argv, options);
    const args = argv.slice(argv.indexOf("-C") + 2);
    if (
      argv[argv.indexOf("-C") + 1] !== fixture.repository ||
      args[0] !== "cat-file" ||
      args[1] !== "blob"
    ) {
      return result;
    }
    const stdout = Buffer.from(result.stdout);
    stdout[0] = stdout[0]! ^ 0xff;
    corrupted++;
    return { ...result, stdout };
  });
  await expect(
    runGitWorkerOperation({
      type: "workspace.artifacts",
      input: {
        root: fixture.repository,
        ref: fixture.stagedResultRef,
        previewPath: fixture.binaryPath,
      },
    }),
  ).rejects.toThrow("payload is invalid");
  expect(corrupted).toBe(1);
});
