import { createHash } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../../media/staged-inputs.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { MAX_WORKSPACE_INVENTORY_ENTRIES } from "./workspace-inventory-limits.js";
import {
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import {
  assertWorkspaceMatchesManifest,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  changedPaths,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-reconcile.js";
import {
  applyWorkspace,
  expectWorkspaceFiles,
  gitInit,
  manifestFor,
  writeWorkspaceFiles,
} from "./workspace-recovery.test-support.js";
import { workerWorkspaceTransferPaths } from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.unstubAllEnvs();
});

async function temporaryDirectory(name: string): Promise<string> {
  return tempDirs.make(`openclaw-${name}-`);
}

async function workspacePair(name: string) {
  return {
    local: await temporaryDirectory(name),
    staged: await temporaryDirectory(`${name}-staged`),
  };
}

async function applyForRecovery(local: string, staged: string, base: WorkerWorkspaceManifest) {
  let journal: WorkerWorkspaceReconciliationJournal | undefined;
  await applyWorkspace({
    root: local,
    stagingRoot: staged,
    base,
    current: await manifestFor(staged),
    begin: (value) => {
      journal = value;
    },
  });
  return journal!;
}

const makeManifest = (entries: WorkerWorkspaceManifestEntry[]): WorkerWorkspaceManifest => ({
  version: 1,
  baseCommit: null,
  entries,
});
const fileEntry = (
  entryPath: string,
  hash = "a",
  size = 1,
): Extract<WorkerWorkspaceManifestEntry, { type: "file" }> => ({
  path: entryPath,
  type: "file",
  mode: 0o644,
  size,
  sha256: hash.repeat(64),
});

function encodeManifest(value: unknown) {
  const raw = JSON.stringify(value);
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

describe("worker workspace reconciliation recovery", () => {
  it("does not follow a symlinked ancestor while recovering journal directories", async () => {
    const { local, staged } = await workspacePair("workspace-directory-recovery-symlink");
    const outside = await temporaryDirectory("workspace-directory-recovery-symlink-outside");
    await fs.mkdir(path.join(local, "parent", "nested"), { recursive: true });
    const base = await manifestFor(local);
    const journal = await applyForRecovery(local, staged, base);
    await fs.symlink(outside, path.join(local, "parent"));

    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("workspace changed while cloud recovery was pending: parent");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("keeps an unsupported local node as a conflict", async () => {
    const { local, staged } = await workspacePair("workspace-unsupported-node-conflict");
    const base = await manifestFor(local);
    const fifoPath = path.join(local, "result.pipe");
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);
    await fs.writeFile(path.join(staged, "result.pipe"), "worker file");

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual(["result.pipe"]);
    expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
    expect(applied.manifest.entries).toEqual([]);
  });

  it("does not block when an expected file is replaced by a FIFO", async () => {
    const local = await temporaryDirectory("workspace-expected-file-fifo");
    const expected = await temporaryDirectory("workspace-expected-file-fifo-manifest");
    await fs.writeFile(path.join(expected, "result.pipe"), "expected");
    const manifest = await manifestFor(expected);
    const fifoPath = path.join(local, "result.pipe");
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);

    await expect(assertWorkspaceMatchesManifest({ root: local, manifest })).rejects.toThrow(
      "Gateway workspace changed after cloud dispatch: result.pipe",
    );
  });

  it("keeps an oversized local version as a conflict", async () => {
    const { local, staged } = await workspacePair("workspace-oversized-node-conflict");
    const base = await manifestFor(local);
    const oversizedPath = path.join(local, "result.bin");
    await fs.writeFile(path.join(staged, "result.bin"), "worker file");
    await fs.writeFile(oversizedPath, "");
    await fs.truncate(oversizedPath, MAX_RECONCILIATION_FILE_BYTES + 1);

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual(["result.bin"]);
    await expect(fs.stat(oversizedPath)).resolves.toMatchObject({
      size: MAX_RECONCILIATION_FILE_BYTES + 1,
    });
    expect(applied.manifest.entries).toEqual([
      expect.objectContaining({
        path: "result.bin",
        type: "file",
        size: MAX_RECONCILIATION_FILE_BYTES + 1,
      }),
    ]);
  });

  it("allows a remote file to replace a new cache-only directory", async () => {
    const { local, staged } = await workspacePair("workspace-new-derived-directory-replacement");
    await gitInit(local);
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "src", "tmp", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "src", "tmp", "__pycache__", "old.pyc"), "local cache");
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("replacement");
  });

  it("rolls back a remote file that replaced a base directory", async () => {
    const local = await temporaryDirectory("workspace-directory-rollback");
    const staged = await temporaryDirectory("workspace-directory-rollback-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "old.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await expect(
      applyWorkspace({
        root: local,
        stagingRoot: staged,
        base,
        current,
        commit: () => {
          throw new Error("placement write failed");
        },
      }),
    ).rejects.toThrow("placement write failed");

    await expect(fs.readFile(path.join(local, "src", "old.txt"), "utf8")).resolves.toBe("base");
  });

  it("restores a file over a directory containing only derived descendants", async () => {
    const { local, staged } = await workspacePair("workspace-directory-recovery-cache");
    await gitInit(local);
    await fs.writeFile(path.join(local, "src"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "src"));
    const journal = await applyForRecovery(local, staged, base);
    await fs.mkdir(path.join(local, "src", "pkg", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "src", "pkg", "__pycache__", "remote.pyc"), "local cache");

    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("base");
  });

  it("does not follow a base symlink while replacing it with a directory", async () => {
    const { local, staged } = await workspacePair("workspace-symlink-replacement");
    await gitInit(local);
    await fs.mkdir(path.join(local, "target"));
    await fs.mkdir(path.join(local, "target", "nested", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "target", "file.txt"), "base target");
    await writeWorkspaceFiles(local, { "target/nested/__pycache__/cache.pyc": "outside cache" });
    await fs.symlink("target", path.join(local, "entry"));
    const base = await manifestFor(local);

    await fs.mkdir(path.join(staged, "target"));
    await fs.writeFile(path.join(staged, "target", "file.txt"), "base target");
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "nested"), "remote directory");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect((await fs.lstat(path.join(local, "entry"))).isDirectory()).toBe(true);
    await expectWorkspaceFiles(local, {
      "entry/nested": "remote directory",
      "target/file.txt": "base target",
      "target/nested/__pycache__/cache.pyc": "outside cache",
    });
  });

  it("does not follow a local-only symlink ancestor omitted from older manifests", async () => {
    const { local, staged } = await workspacePair("workspace-local-only-symlink-ancestor");
    const outside = await temporaryDirectory("workspace-local-only-symlink-ancestor-outside");
    await fs.writeFile(path.join(outside, "worker.txt"), "outside local");
    await fs.symlink(outside, path.join(local, "link"));
    await fs.mkdir(path.join(staged, "link"));
    await fs.writeFile(path.join(staged, "link", "worker.txt"), "worker result");
    const current = await manifestFor(staged);
    current.directories = [];

    const result = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base: { version: 1, baseCommit: null, entries: [], directories: [] },
      current,
    });

    expect(result.conflictPaths).toEqual(["link"]);
    expect((await fs.lstat(path.join(local, "link"))).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(path.join(outside, "worker.txt"), "utf8")).resolves.toBe(
      "outside local",
    );
  });

  it.each(["ordinary", "private input"])(
    "rolls back when durable acceptance fails (%s)",
    async (mode) => {
      const { local, staged } = await workspacePair("workspace-rollback");
      await gitInit(local);
      const directory = stagedInputDirectory("b".repeat(64));
      if (mode === "private input") {
        await ensureStagedInputDirectory(local, directory);
        await ensureStagedInputDirectory(staged, directory);
      }
      const file = mode === "private input" ? `${directory}/input-cache.pyc` : "file.txt";
      await fs.writeFile(path.join(local, file), "base");
      const base = await manifestFor(local);
      await fs.writeFile(path.join(staged, file), "remote");
      await fs.writeFile(path.join(staged, "added.txt"), "remote");
      const current = await manifestFor(staged);
      let aborted = false;

      await expect(
        applyWorkspace({
          root: local,
          stagingRoot: staged,
          base,
          current,
          commit: () => {
            throw new Error("placement write failed");
          },
          abort: () => {
            aborted = true;
          },
        }),
      ).rejects.toThrow("placement write failed");
      expect(aborted).toBe(true);
      await expect(fs.readFile(path.join(local, file), "utf8")).resolves.toBe("base");
      await expect(fs.access(path.join(local, "added.txt"))).rejects.toThrow();
    },
  );

  it("refuses to roll back a file-to-directory replacement over a later local child", async () => {
    const { local, staged } = await workspacePair("workspace-file-directory-recovery-local-child");
    await fs.writeFile(path.join(local, "entry"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "cloud.txt"), "worker");
    const journal = await applyForRecovery(local, staged, base);
    await fs.writeFile(path.join(local, "entry", "local.txt"), "later local");

    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("entry");
    await expect(fs.readFile(path.join(local, "entry", "local.txt"), "utf8")).resolves.toBe(
      "later local",
    );
  });

  it("recovers SHA-1 journals under SHA-256 defaults before and after partial apply", async () => {
    vi.stubEnv("GIT_DEFAULT_HASH", "sha256");
    const { local, staged } = await workspacePair("workspace-crash-recovery");
    await gitInit(local);
    await fs.writeFile(path.join(local, "file.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "file.txt"), "remote");
    await fs.writeFile(path.join(staged, "added.txt"), "remote");
    const journal = await applyForRecovery(local, staged, base);
    expect(journal).toBeDefined();
    expect(journal?.baseTree).toMatch(/^[a-f0-9]{40}$/u);
    // Simulate interruption after the addition but before the modification.
    await fs.writeFile(path.join(local, "file.txt"), "base");
    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });
    await expect(fs.readFile(path.join(local, "file.txt"), "utf8")).resolves.toBe("base");
    await expect(fs.access(path.join(local, "added.txt"))).rejects.toThrow();
    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });

    await fs.rm(path.join(local, "file.txt"));
    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("workspace changed while cloud recovery was pending");
    await expect(fs.access(path.join(local, "file.txt"))).rejects.toThrow();
  });

  it("ignores derived paths in a journal created before the exclusion", async () => {
    const { local, staged } = await workspacePair("workspace-derived-recovery");
    await gitInit(local);
    await writeWorkspaceFiles(local, { "file.txt": "base", ":literal.ts": "base literal" });
    const base = await manifestFor(local);
    await writeWorkspaceFiles(staged, { "file.txt": "remote", ":literal.ts": "remote literal" });
    const journal = await applyForRecovery(local, staged, base);
    expect(journal).toBeDefined();
    expect(journal!.baseEntries.map((entry) => entry.path)).toContain(":literal.ts");
    expect(await fs.readFile(path.join(local, ":literal.ts"), "utf8")).toBe("remote literal");
    const withLegacyDerivedPath = (entry: WorkerWorkspaceManifestEntry) => {
      if (entry.path !== "file.txt") {
        return entry;
      }
      const legacyEntry = structuredClone(entry);
      legacyEntry.path = "__pycache__/file.pyc";
      return legacyEntry;
    };
    const legacyJournal = {
      ...journal!,
      baseEntries: journal!.baseEntries.map(withLegacyDerivedPath),
      appliedEntries: journal!.appliedEntries.map(withLegacyDerivedPath),
    } satisfies WorkerWorkspaceReconciliationJournal;
    await fs.mkdir(path.join(local, "__pycache__"));
    await fs.writeFile(path.join(local, "__pycache__/file.pyc"), "local cache");

    await expect(
      recoverWorkerWorkspaceReconciliation({
        root: local,
        journal: {
          ...legacyJournal,
          baseEntries: legacyJournal.baseEntries.map((entry) =>
            entry.path === ":literal.ts" && entry.type === "file"
              ? { ...entry, sha256: "0".repeat(64) }
              : entry,
          ),
        },
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(local, ":literal.ts"), "utf8")).toBe("remote literal");

    await recoverWorkerWorkspaceReconciliation({ root: local, journal: legacyJournal });

    await expectWorkspaceFiles(local, {
      "file.txt": "remote",
      ":literal.ts": "base literal",
      "__pycache__/file.pyc": "local cache",
    });
  });

  it("does not follow a symlink-raced ancestor during Git patch application", async () => {
    const { local, staged } = await workspacePair("workspace-symlink-race");
    const outside = await temporaryDirectory("workspace-symlink-race-outside");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "file.txt"), "base");
    await fs.mkdir(path.join(staged, "src"));
    await fs.writeFile(path.join(staged, "src", "file.txt"), "remote");
    await fs.writeFile(path.join(outside, "file.txt"), "outside");
    const base = await manifestFor(local);
    const current = await manifestFor(staged);

    await expect(
      applyWorkspace({
        root: local,
        stagingRoot: staged,
        base,
        current,
        begin: () => {
          renameSync(path.join(local, "src"), path.join(local, "original-src"));
          symlinkSync(outside, path.join(local, "src"));
        },
      }),
    ).rejects.toThrow();
    await expect(fs.readFile(path.join(outside, "file.txt"), "utf8")).resolves.toBe("outside");
  });

  it("authenticates manifests, normalizes Git modes, and rejects escaping symlinks", () => {
    const value = {
      version: 1,
      baseCommit: null,
      entries: [
        { path: "dir", type: "directory", mode: 0o700 },
        { path: "dir/file", type: "file", mode: 0o600, size: 1, sha256: "a".repeat(64) },
      ],
    };
    const encoded = encodeManifest(value);
    expect(parseWorkerWorkspaceManifest(encoded.raw, encoded.ref).entries).toEqual([
      { path: "dir/file", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) },
    ]);
    const legacyDerived = encodeManifest({
      version: 1,
      baseCommit: null,
      entries: [
        { path: "__pycache__", type: "directory", mode: 0o700 },
        {
          path: "__pycache__/fizzbuzz.pyc",
          type: "file",
          mode: 0o600,
          size: 1,
          sha256: "b".repeat(64),
        },
      ],
    });
    expect(parseWorkerWorkspaceManifest(legacyDerived.raw, legacyDerived.ref)).toMatchObject({
      entries: [],
      directories: [],
    });
    expect(() => parseWorkerWorkspaceManifest(`${encoded.raw} `, encoded.ref)).toThrow("digest");
    for (const target of ["../outside", "..\\outside", "C:/outside"]) {
      const invalid = encodeManifest({
        version: 1,
        baseCommit: null,
        entries: [{ path: "link", type: "symlink", mode: 0o777, target }],
      });
      expect(() => parseWorkerWorkspaceManifest(invalid.raw, invalid.ref)).toThrow("symlink");
    }
  });

  it("returns only changed current payload paths", () => {
    const base = makeManifest([fileEntry("a", "a"), fileEntry("b", "b")]);
    const current = makeManifest([fileEntry("a", "c"), fileEntry("c", "d")]);
    expect(workerWorkspaceTransferPaths(current, base)).toEqual(["a", "c"]);

    const oversized = fileEntry("large", "e");
    oversized.size = MAX_RECONCILIATION_FILE_BYTES + 1;
    expect(() => workerWorkspaceTransferPaths(makeManifest([oversized]), makeManifest([]))).toThrow(
      /^Cloud workspace result is too large: large$/,
    );
  });

  it("compares decoded entries by their typed fields and honors cancellation", () => {
    const file = fileEntry("file");
    const base = makeManifest([file]);
    const current: WorkerWorkspaceManifest = {
      ...base,
      entries: [
        { sha256: file.sha256, size: file.size, mode: file.mode, type: file.type, path: file.path },
      ],
    };
    expect(workerWorkspaceTransferPaths(current, base)).toEqual([]);
    expect([...changedPaths(base, current)]).toEqual([]);
    for (const change of [{ mode: 0o755 }, { size: 2 }, { sha256: "b".repeat(64) }]) {
      expect(
        workerWorkspaceTransferPaths({ ...current, entries: [{ ...file, ...change }] }, base),
      ).toEqual(["file"]);
    }
    const controller = new AbortController();
    const reason = new Error("workspace owner closed");
    controller.abort(reason);
    expect(() => workerWorkspaceTransferPaths(current, base, controller.signal)).toThrow(reason);
  });

  it("preserves directory transitions, deletion accounting, and payload order", () => {
    const base: WorkerWorkspaceManifest = {
      version: 1,
      baseCommit: null,
      directories: ["old-empty", "to-file"],
      entries: [
        fileEntry("to-directory", "a", 0),
        fileEntry("to-file/child", "a", 0),
        { path: "link", type: "symlink", mode: 0o777, target: "before" },
      ],
    };
    const current: WorkerWorkspaceManifest = {
      version: 1,
      baseCommit: null,
      directories: ["new-empty", "to-directory"],
      entries: [
        { path: "link", type: "symlink", mode: 0o777, target: "after" },
        fileEntry("to-file", "a", 0),
        fileEntry("to-directory/child", "a", 0),
      ],
    };
    expect(workerWorkspaceTransferPaths(current, base)).toEqual([
      "link",
      "to-file",
      "to-directory/child",
    ]);
    expect([...changedPaths(base, current)]).toEqual([
      "old-empty",
      "to-file",
      "to-directory",
      "to-file/child",
      "link",
      "new-empty",
      "to-directory/child",
    ]);
    expect(workerWorkspaceTransferPaths({ ...base, entries: [], directories: [] }, base)).toEqual(
      [],
    );
  });

  it("retains owned input payloads while excluding ordinary derived paths", async () => {
    const local = await temporaryDirectory("workspace-comparison-inputs");
    const directory = stagedInputDirectory("a".repeat(64));
    await ensureStagedInputDirectory(local, directory);
    await fs.writeFile(path.join(local, directory, "input.pyc"), "base");
    await fs.mkdir(path.join(local, "node_modules"));
    await fs.writeFile(path.join(local, "node_modules", "cache"), "base");
    const base = await manifestFor(local);
    const current: WorkerWorkspaceManifest = {
      ...base,
      entries: base.entries.map((entry) =>
        entry.type === "file" && !entry.path.endsWith(".gitignore")
          ? { ...entry, sha256: "b".repeat(64) }
          : entry,
      ),
    };
    expect(workerWorkspaceTransferPaths(current, base)).toEqual([`${directory}/input.pyc`]);
    expect([...changedPaths(base, current)]).toEqual([`${directory}/input.pyc`]);
  });

  it("counts only changed payload bytes and includes UTF-8 symlink targets", () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      fileEntry(`file-${index}`, "a", MAX_RECONCILIATION_FILE_BYTES),
    );
    const empty = makeManifest([]);
    const current: WorkerWorkspaceManifest = { ...empty, entries };
    expect(
      entries.reduce((bytes, entry) => bytes + (entry.type === "file" ? entry.size : 0), 0),
    ).toBe(MAX_RECONCILIATION_TOTAL_BYTES);
    expect(workerWorkspaceTransferPaths(current, empty)).toEqual(
      entries.map((entry) => entry.path),
    );
    const extra: WorkerWorkspaceManifest = {
      ...current,
      entries: [...entries, { path: "link", type: "symlink", mode: 0o777, target: "a" }],
    };
    const lastIndex = entries.length - 1;
    const lastFile = entries[lastIndex]!;
    if (lastFile.type === "file") {
      extra.entries[lastIndex] = { ...lastFile, size: lastFile.size - 1 };
    }
    expect(workerWorkspaceTransferPaths(extra, empty)).toEqual([
      ...entries.map((entry) => entry.path),
      "link",
    ]);
    extra.entries[entries.length] = { path: "link", type: "symlink", mode: 0o777, target: "é" };
    expect(() => workerWorkspaceTransferPaths(extra, empty)).toThrow(
      "staged result exceeds its byte limit",
    );
    expect(workerWorkspaceTransferPaths(extra, current)).toEqual([lastFile.path, "link"]);
  });

  it("accepts a directory replacement spanning two complete supported inventories", () => {
    const manifest = (prefix: string): WorkerWorkspaceManifest => ({
      version: 1,
      baseCommit: null,
      entries: [],
      directories: Array.from(
        { length: MAX_WORKSPACE_INVENTORY_ENTRIES },
        (_, index) => `${prefix}-${index.toString().padStart(6, "0")}`,
      ),
    });
    const base = manifest("removed");
    const current = manifest("added");

    expect(workerWorkspaceTransferPaths(current, base)).toEqual([]);
    expect(changedPaths(base, current).size).toBe(2 * MAX_WORKSPACE_INVENTORY_ENTRIES);
  });
});
