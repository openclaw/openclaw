import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import * as commandRuntime from "../../process/exec.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { updateWorkspaceResultRefs } from "./workspace-result-git.js";
import {
  deleteWorkerWorkspaceResultCleanupRefs,
  hasWorkerWorkspaceResultRef,
  moveStagedWorkerWorkspaceResultToCleanup,
  preparedWorkerWorkspaceResultRef,
  withStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await drainGlobalSingletonLifecycleState();
  vi.unstubAllEnvs();
});

const manifestRef = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const manifest = (entries: WorkerWorkspaceManifestEntry[]) =>
  serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries });
type FixtureOptions = {
  largeFileBytes?: number;
  objectFormat?: "sha1" | "sha256";
  linked?: boolean;
};
function flipByte(bytes: Buffer, index: number, mask = 0xff) {
  bytes[index] = bytes[index]! ^ mask;
  return bytes;
}

function corruptBatch(
  repository: string,
  corrupt: (bytes: Buffer) => Buffer,
  matches = (args: string[]) => args.includes("--batch"),
) {
  const runBuffered = commandRuntime.runCommandBuffered;
  const transform = vi.fn(corrupt);
  vi.spyOn(commandRuntime, "runCommandBuffered").mockImplementation(async (argv, options) => {
    const result = await runBuffered(argv, options);
    if (
      argv[argv.indexOf("-C") + 1] === repository &&
      matches(argv.slice(argv.indexOf("-C") + 2))
    ) {
      return { ...result, stdout: transform(Buffer.from(result.stdout)) };
    }
    return result;
  });
  return transform;
}

const git = (root: string, args: string[]) =>
  requireGit(root, ["-c", "core.longpaths=true", ...args], { timeoutMs: 10_000 });

async function stagedFixture(
  fileCount = 64,
  { largeFileBytes = 0, objectFormat = "sha1", linked = false }: FixtureOptions = {},
) {
  const root = await fs.realpath(tempDirs.make("workspace-staged-reads-"));
  let repository = path.join(
    root,
    linked
      ? (process.platform === "win32" ? "repository-" : "repository-\n").padEnd(
          190 - root.length - 1,
          "r",
        )
      : "repository",
  );
  const input = path.join(root, "input");
  await Promise.all([fs.mkdir(repository), fs.mkdir(input)]);
  if (objectFormat === "sha256" || linked) {
    await git(repository, ["init", "--quiet", "--template=", `--object-format=${objectFormat}`]);
  }
  if (linked) {
    await git(repository, ["config", "core.longpaths", "false"]);
    await git(repository, [
      "-c",
      "user.name=Workspace Test",
      "-c",
      "user.email=workspace@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base",
    ]);
    const linkedRoot = path.join(
      root,
      process.platform === "win32" ? "linked-result-worktree" : "linked\nresult-worktree",
    );
    await git(repository, ["worktree", "add", "--quiet", "--detach", "--", linkedRoot, "HEAD"]);
    vi.stubEnv("GIT_COMMON_DIR", path.relative(linkedRoot, path.join(repository, ".git")));
    repository = linkedRoot;
  }
  const originalHead = linked ? await git(repository, ["rev-parse", "HEAD"]) : undefined;
  const files = new Map<string, Buffer>();
  for (let index = 0; index < fileCount; index++) {
    files.set(`file-${String(index).padStart(3, "0")}.txt`, Buffer.from(`payload ${index}\n`));
  }
  const binaryPath = process.platform === "win32" ? "binary.bin" : "binary\nname.bin";
  files.set(binaryPath, Buffer.from([0, 10, 255, 13, 10, 0, 65]));
  files.set("executable.sh", Buffer.from("#!/bin/sh\nexit 0\n"));
  if (largeFileBytes) {
    files.set("large.bin", Buffer.alloc(largeFileBytes, 0x5a));
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
  const baseManifestRaw = manifest([]);
  const currentManifestRaw = manifest(entries);
  const publishedRef = workerWorkspaceResultRef("read-batch");
  const stagedResultRef = linked ? preparedWorkerWorkspaceResultRef(publishedRef) : publishedRef;
  const commit = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root: repository,
    stagingRoot: input,
    stagedResultRef,
    baseManifestRaw,
    currentManifestRaw,
    baseManifestRef: manifestRef(baseManifestRaw),
    currentManifestRef: manifestRef(currentManifestRaw),
  });
  return {
    read: (use: Parameters<typeof withStagedWorkerWorkspaceResult>[1]) =>
      withStagedWorkerWorkspaceResult({ root: repository, stagedResultRef }, use),
    repository,
    stagedResultRef,
    publishedRef,
    originalHead,
    commit,
    files,
    binaryPath,
  };
}

it.each<[number, number, FixtureOptions]>([
  [64, 4, { linked: true }],
  [300, 6, {}],
  [0, 4, { largeFileBytes: 9 * 1024 * 1024 }],
  [0, 4, { objectFormat: "sha256" }],
])(
  "materializes %i files with at most %i Git reads (%j)",
  async (fileCount, maxReads, fixtureOptions) => {
    const fixture = await stagedFixture(fileCount, fixtureOptions);
    expect(fixture.commit).toBe(
      await git(fixture.repository, ["rev-parse", `${fixture.stagedResultRef}^{commit}`]),
    );
    const gitReads: string[][] = [];
    const runBuffered = commandRuntime.runCommandBuffered;
    vi.spyOn(commandRuntime, "runCommandBuffered").mockImplementation(async (argv, options) => {
      if (argv[argv.indexOf("-C") + 1] === fixture.repository) {
        gitReads.push(argv.slice(argv.indexOf("-C") + 2, argv.indexOf("-C") + 4));
      }
      return await runBuffered(argv, options);
    });
    const writes = vi.spyOn(fs, "writeFile");
    const links = vi.spyOn(fs, "symlink");
    let stagingRoot = "";
    await fixture.read(async (snapshot) => {
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
      const materialized = [
        ...writes.mock.calls.map(([target]) => {
          assert(typeof target === "string");
          return target;
        }),
        ...links.mock.calls.map(([, target]) => String(target)),
      ];
      expect(
        materialized.filter((target) => target.startsWith(stagingRoot + path.sep)).toSorted(),
      ).toEqual(
        snapshot.changedEntries.map((entry) => path.join(stagingRoot, entry.path)).toSorted(),
      );
    });
    await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitReads.length, JSON.stringify(gitReads)).toBeLessThanOrEqual(maxReads);
    if (fixtureOptions.linked) {
      const root = fixture.repository;
      const refParams = (stagedResultRef: string) => ({ root, stagedResultRef });
      const hasRef = (ref: string) => hasWorkerWorkspaceResultRef(refParams(ref));
      await updateWorkspaceResultRefs(fixture.repository, [
        { ref: fixture.publishedRef, objectId: fixture.commit },
        { ref: fixture.stagedResultRef },
      ]);
      await expect(hasRef(fixture.stagedResultRef)).resolves.toBe(false);
      const cleanupRef = await moveStagedWorkerWorkspaceResultToCleanup(
        refParams(fixture.publishedRef),
      );
      await expect(hasRef(cleanupRef)).resolves.toBe(true);
      await deleteWorkerWorkspaceResultCleanupRefs({ root: fixture.repository });
      await expect(hasRef(cleanupRef)).resolves.toBe(false);
      expect(await fs.readdir(fixture.repository)).toEqual([".git"]);
      expect(await git(fixture.repository, ["rev-parse", "HEAD"])).toBe(fixture.originalHead);
      expect(await git(fixture.repository, ["config", "--local", "--get", "core.longpaths"])).toBe(
        "false",
      );
    }
  },
);

it.each(
  (["oid", "type", "size", "digest", "truncated", "trailing", "symlink"] as const).filter(
    (corruption) => corruption !== "symlink" || process.platform !== "win32",
  ),
)(
  "rejects a batch with invalid %s before writing staged files and cleans its temporary directory",
  async (corruption) => {
    const fixture = await stagedFixture(0);
    const corrupted = corruptBatch(fixture.repository, (bytes) => {
      const headerEnd = bytes.indexOf(0x0a);
      expect(headerEnd).toBeGreaterThan(0);
      switch (corruption) {
        case "oid":
          bytes[0] = bytes[0] === 0x30 ? 0x31 : 0x30;
          return bytes;
        case "type":
          bytes.write("tree", bytes.indexOf(" blob ") + 1);
          return bytes;
        case "size":
          return Buffer.concat([
            Buffer.from(bytes.subarray(0, headerEnd).toString("utf8").replace(/\d+$/u, "0")),
            bytes.subarray(headerEnd),
          ]);
        case "digest":
          return flipByte(bytes, headerEnd + 1);
        case "truncated":
          return bytes.subarray(0, -1);
        case "trailing":
          return Buffer.concat([bytes, Buffer.from([0])]);
        case "symlink": {
          const target = bytes.indexOf(fixture.binaryPath);
          expect(target).toBeGreaterThan(0);
          return flipByte(bytes, target, 1);
        }
        default:
          throw new Error("Unexpected corruption fixture");
      }
    });
    const temporary = vi.spyOn(fs, "mkdtemp");
    const writes = vi.spyOn(fs, "writeFile");
    const links = vi.spyOn(fs, "symlink");
    const use = vi.fn(async () => {});
    await expect(fixture.read(use)).rejects.toThrow(
      corruption === "symlink" ? "payload is invalid: current-link" : "payload",
    );
    expect(corrupted).toHaveBeenCalledOnce();
    for (const effect of [use, writes, links]) {
      expect(effect).not.toHaveBeenCalled();
    }
    expect(temporary).toHaveBeenCalledOnce();
    const created = temporary.mock.results[0];
    assert(created?.type === "return", "Staging did not create its temporary directory");
    await expect(fs.stat(await created.value)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("authenticates the singleton blob returned by checkpoint previews", async () => {
  const fixture = await stagedFixture(0);
  const corrupted = corruptBatch(
    fixture.repository,
    (stdout) => flipByte(stdout, stdout.indexOf(0x0a) + 1),
    (args) => args[0] === "cat-file" && args[1] === "--batch",
  );
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
  expect(corrupted).toHaveBeenCalledOnce();
});
