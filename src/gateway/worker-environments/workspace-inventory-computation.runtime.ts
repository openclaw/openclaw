import { createReadStream, lstatSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { requestGitWorkerEffect } from "../../infra/git-worker-context.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import {
  createStagedInputPathMatcher,
  stagedInputPathDirectory,
} from "../../media/staged-inputs.js";
import { isPortableRootContainedSymlink } from "./workspace-actual-manifest.js";
import type {
  WorkspaceInventoryComputationCommand,
  WorkspaceInventoryComputationResult,
} from "./workspace-inventory-computation.js";
import { workspaceInventoryError } from "./workspace-inventory-error.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
  MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-inventory-limits.js";
import { gitFileMode } from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

/** Exact rsync exemptions, prepared once without walking input file contents. */
async function readStagedInputDirectories(rootDir: string): Promise<string[]> {
  const root = await fsRoot(rootDir);
  const inbound = await root.stat("media/inbound").catch(() => undefined);
  if (!inbound?.isDirectory || inbound.isSymbolicLink) {
    return [];
  }
  const isStagedInput = createStagedInputPathMatcher(root);
  const directories: string[] = [];
  let candidates = 0;
  for await (const entry of await fs.opendir(path.join(rootDir, "media/inbound"))) {
    if (++candidates > MAX_WORKSPACE_INVENTORY_ENTRIES) {
      throw workspaceInventoryError("Cloud workspace has too many entries");
    }
    const directory = stagedInputPathDirectory(`media/inbound/${entry.name}`);
    if (entry.isDirectory() && directory && (await isStagedInput(directory))) {
      directories.push(directory);
    }
  }
  return directories.toSorted();
}

async function writeChunk(value: string): Promise<void> {
  await requestGitWorkerEffect({
    type: "workspace.inventory.write",
    input: { bytes: Uint8Array.from(Buffer.from(value)) },
  });
}

type WorkerWorkspaceInventoryEntry =
  | { path: string; type: "directory" }
  | { path: string; type: "file"; mode: number; size: number }
  | { path: string; type: "symlink"; target: string };

function assertWorkerWorkspaceInventoryValues(
  manifestEntries: number,
  manifestPathBytes: number,
  transferPathBytes: number,
  manifestBytes: number,
  eligibleBytes: number,
): void {
  if (manifestEntries > MAX_WORKSPACE_INVENTORY_ENTRIES) {
    throw workspaceInventoryError(
      `Cloud workspace inventory exceeds ${MAX_WORKSPACE_INVENTORY_ENTRIES} manifest entries; reduce eligible files or narrow .worktreeinclude`,
    );
  }
  if (manifestPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
    throw workspaceInventoryError(
      "Cloud workspace manifest paths exceed the 64 MiB metadata limit; reduce eligible files or shorten their paths",
    );
  }
  if (transferPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
    throw workspaceInventoryError(
      "Cloud workspace eligible paths exceed the 64 MiB metadata limit; reduce eligible files or narrow .worktreeinclude",
    );
  }
  if (manifestBytes > MAX_WORKSPACE_MANIFEST_BYTES) {
    throw workspaceInventoryError(
      "Cloud workspace manifest exceeds the 64 MiB limit; reduce eligible files or shorten their paths",
    );
  }
  if (eligibleBytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
    throw workspaceInventoryError(
      "Cloud workspace eligible content exceeds the 4 GiB limit; remove large eligible files or ignore them",
    );
  }
}

function inventoryEntryJson(entry: WorkerWorkspaceInventoryEntry): string {
  if (entry.type === "directory") {
    return JSON.stringify({ path: entry.path, type: entry.type, mode: 0o700 });
  }
  if (entry.type === "symlink") {
    return JSON.stringify({
      path: entry.path,
      type: entry.type,
      mode: 0o777,
      target: entry.target,
    });
  }
  return JSON.stringify({
    path: entry.path,
    type: entry.type,
    mode: gitFileMode(entry.mode),
    size: entry.size,
    sha256: "0".repeat(64),
  });
}

class WorkerWorkspaceInventoryBudget {
  readonly #paths = new Set<string>();
  readonly #emptyManifestBytes = Buffer.byteLength(
    JSON.stringify({ version: 1, baseCommit: "0".repeat(64), entries: [] }),
  );
  #manifestPathBytes = 0;
  #transferPathBytes = 0;
  #manifestEntryBytes = 0;
  #eligibleBytes = 0;

  #assert(): void {
    const manifestEntries = this.#paths.size;
    assertWorkerWorkspaceInventoryValues(
      manifestEntries,
      this.#manifestPathBytes,
      this.#transferPathBytes,
      this.#emptyManifestBytes + this.#manifestEntryBytes + Math.max(0, manifestEntries - 1),
      this.#eligibleBytes,
    );
  }

  addTransferPath(entryPath: string): void {
    this.#transferPathBytes += Buffer.byteLength(entryPath) + 1;
    this.#assert();
  }

  addEntry(entry: WorkerWorkspaceInventoryEntry): void {
    if (this.#paths.has(entry.path)) {
      return;
    }
    this.#paths.add(entry.path);
    this.#manifestPathBytes += Buffer.byteLength(entry.path);
    this.#eligibleBytes +=
      entry.type === "file"
        ? entry.size
        : entry.type === "symlink"
          ? Buffer.byteLength(entry.target)
          : 0;
    this.#manifestEntryBytes += Buffer.byteLength(inventoryEntryJson(entry));
    this.#assert();
  }
}

function validateGitRelativePath(file: string): string {
  if (
    !file ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file === ".." ||
    file.startsWith("../")
  ) {
    throw new Error("Worker workspace git file list contains an unsafe path");
  }
  return file;
}

async function* readBoundedGitPathCandidates(filePath: string): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  let candidateCount = 0;
  let pathBytes = 0;
  for await (const value of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    pathBytes += chunk.byteLength;
    if (pathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      throw workspaceInventoryError("Cloud workspace Git path metadata exceeds the 64 MiB limit");
    }
    const buffer = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let offset = 0;
    for (;;) {
      const separator = buffer.indexOf(0, offset);
      if (separator < 0) {
        break;
      }
      candidateCount += 1;
      if (candidateCount > MAX_WORKSPACE_GIT_CANDIDATES) {
        throw workspaceInventoryError(
          `Cloud workspace Git path candidates exceed the ${MAX_WORKSPACE_GIT_CANDIDATES} limit`,
        );
      }
      yield validateGitRelativePath(buffer.subarray(offset, separator).toString("utf8"));
      offset = separator + 1;
    }
    pending = Buffer.from(buffer.subarray(offset));
  }
  if (pending.length > 0) {
    throw new Error("Worker workspace git file list is not NUL terminated");
  }
}

async function selectTransferPaths(params: {
  gitRoot: string;
  eligiblePath: string;
  ignoredPath: string;
  selectedPath: string;
}): Promise<void> {
  const canonicalRoot = await fs.realpath(params.gitRoot);
  const isStagedInput = createStagedInputPathMatcher(await fsRoot(canonicalRoot));
  const budget = new WorkerWorkspaceInventoryBudget();
  const transferredPaths = new Set<string>();
  let buffered: string[] = [];
  let bufferedBytes = 0;
  const flush = async () => {
    if (buffered.length === 0) {
      return;
    }
    await writeChunk(buffered.join(""));
    buffered = [];
    bufferedBytes = 0;
  };
  const inspectFile = async (
    file: string,
  ): Promise<Exclude<WorkerWorkspaceInventoryEntry, { type: "directory" }> | undefined> => {
    if (isDerivedWorkspacePath(file, await isStagedInput(file)) || transferredPaths.has(file)) {
      return undefined;
    }
    const absolute = path.join(canonicalRoot, file);
    const stats = (() => {
      try {
        return lstatSync(absolute);
      } catch (error) {
        if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
          return undefined;
        }
        throw error;
      }
    })();
    // Gitlinks are directories. Keep their commit in the base repository without
    // recursively copying nested repositories or their credential-bearing metadata.
    if (!stats || (!stats.isFile() && !stats.isSymbolicLink())) {
      return undefined;
    }
    if (stats.isSymbolicLink()) {
      // Mirrors the remote manifest guard, but before transfer: macOS openrsync
      // stat-fails escaping links with an opaque error instead of copying them.
      const symlinkTarget = readlinkSync(absolute);
      if (!isPortableRootContainedSymlink(canonicalRoot, file, symlinkTarget)) {
        throw workspaceInventoryError(
          `Cloud workspace symlink is not portable or escapes the sync root: ${sliceUtf16Safe(file, 0, 160)}`,
        );
      }
      return { path: file, type: "symlink", target: symlinkTarget };
    }
    return { path: file, type: "file", mode: stats.mode & 0o777, size: stats.size };
  };
  const append = async (entry: Exclude<WorkerWorkspaceInventoryEntry, { type: "directory" }>) => {
    const file = entry.path;
    if (transferredPaths.has(file)) {
      return;
    }
    transferredPaths.add(file);
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      budget.addEntry({ path: segments.slice(0, index).join("/"), type: "directory" });
    }
    budget.addEntry(entry);
    budget.addTransferPath(file);
    const record = `${file}\0`;
    buffered.push(record);
    bufferedBytes += Buffer.byteLength(record);
    if (bufferedBytes >= 64 * 1024) {
      await flush();
    }
  };
  async function* candidates() {
    yield* readBoundedGitPathCandidates(params.eligiblePath);
    const selected = readBoundedGitPathCandidates(params.selectedPath);
    try {
      let selectedItem = await selected.next();
      for await (const file of readBoundedGitPathCandidates(params.ignoredPath)) {
        while (
          !selectedItem.done &&
          Buffer.compare(Buffer.from(selectedItem.value), Buffer.from(file)) < 0
        ) {
          selectedItem = await selected.next();
        }
        if ((await isStagedInput(file)) || (!selectedItem.done && selectedItem.value === file)) {
          yield file;
        }
      }
      while (!selectedItem.done) {
        selectedItem = await selected.next();
      }
    } finally {
      await selected.return(undefined);
    }
  }
  for await (const file of candidates()) {
    const entry = await inspectFile(file);
    if (entry) {
      await append(entry);
    }
  }
  await flush();
}

async function filterExistingPaths(params: {
  gitRoot: string;
  preparedListPath: string;
}): Promise<void> {
  let records: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (records.length) {
      await writeChunk(records.join(""));
      records = [];
      bytes = 0;
    }
  };
  for await (const file of readBoundedGitPathCandidates(params.preparedListPath)) {
    let stats;
    try {
      stats = lstatSync(path.join(params.gitRoot, file));
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    if (stats?.isFile() || stats?.isSymbolicLink()) {
      const record = `${file}\0`;
      records.push(record);
      bytes += Buffer.byteLength(record);
      if (bytes >= 64 * 1024) {
        await flush();
      }
    }
  }
  await flush();
}

export async function executeWorkspaceInventoryComputation(
  command: WorkspaceInventoryComputationCommand,
): Promise<WorkspaceInventoryComputationResult> {
  switch (command.type) {
    case "workspace.inventory.staged-directories":
      return await readStagedInputDirectories(command.input.rootDir);
    case "workspace.inventory.select":
      return await selectTransferPaths(command.input);
    case "workspace.inventory.existing":
      return await filterExistingPaths(command.input);
    case "workspace.inventory.paths": {
      const paths = new Set<string>();
      for await (const entry of readBoundedGitPathCandidates(command.input.filePath)) {
        paths.add(entry);
      }
      return paths;
    }
  }
}
