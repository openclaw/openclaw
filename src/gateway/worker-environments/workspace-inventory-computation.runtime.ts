import { isUtf8 } from "node:buffer";
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
import {
  WORKER_WORKSPACE_GIT_PATHS_UTF8_MESSAGE,
  gitFileMode,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

function createInventoryPathWriter() {
  let records: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (records.length === 0) {
      return;
    }
    await requestGitWorkerEffect({
      type: "workspace.inventory.write",
      input: { bytes: Uint8Array.from(Buffer.from(records.join(""))) },
    });
    records = [];
    bytes = 0;
  };
  return {
    flush,
    append(file: string): Promise<void> | undefined {
      const record = `${file}\0`;
      records.push(record);
      bytes += Buffer.byteLength(record);
      if (bytes >= 64 * 1024) {
        return flush();
      }
      return undefined;
    },
  };
}

type WorkerWorkspaceInventoryEntry =
  | { path: string; type: "directory"; mode: number }
  | WorkerWorkspaceManifestEntry;

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

type GitPathCandidate = {
  /** Bytes Git reported. `name` is their lossy spelling, their own path only when they round-trip. */
  readonly raw: Buffer;
  readonly name: string;
};

async function* readBoundedGitPathCandidates(filePath: string): AsyncGenerator<GitPathCandidate> {
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
      const raw = buffer.subarray(offset, separator);
      yield { raw, name: validateGitRelativePath(raw.toString("utf8")) };
      offset = separator + 1;
    }
    pending = Buffer.from(buffer.subarray(offset));
  }
  if (pending.length > 0) {
    throw new Error("Worker workspace git file list is not NUL terminated");
  }
}

function gitPathIsDecodable(candidate: GitPathCandidate): boolean {
  // Same predicate the manifest script applies to the names it captures.
  return isUtf8(candidate.raw);
}

/**
 * A name that does not survive UTF-8 decoding only reaches its file through its raw bytes; asking
 * for the replacement spelling is what made an existing file look deleted. Vanished names stay
 * tolerant here, matching the remote capture that records a reclaim deletion as absent (#108398).
 */
function existingRawGitPath(root: string, candidate: GitPathCandidate): boolean {
  if (process.platform === "win32") {
    return false;
  }
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  try {
    lstatSync(Buffer.concat([Buffer.from(prefix), candidate.raw]));
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

export async function executeWorkspaceInventoryComputation(
  command: WorkspaceInventoryComputationCommand,
): Promise<WorkspaceInventoryComputationResult> {
  switch (command.type) {
    case "workspace.inventory.staged-directories": {
      // Exact rsync exemptions, prepared once without walking input file contents.
      const rootDir = command.input.rootDir;
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
    case "workspace.inventory.select": {
      const params = command.input;
      const canonicalRoot = await fs.realpath(params.gitRoot);
      const isStagedInput = createStagedInputPathMatcher(await fsRoot(canonicalRoot));
      const manifestPaths = new Set<string>();
      const emptyManifestBytes = Buffer.byteLength(
        JSON.stringify({ version: 1, baseCommit: "0".repeat(64), entries: [] }),
      );
      let manifestPathBytes = 0;
      let transferPathBytes = 0;
      let manifestEntryBytes = 0;
      let eligibleBytes = 0;
      const assertBudget = (): void => {
        const manifestEntries = manifestPaths.size;
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
        if (
          emptyManifestBytes + manifestEntryBytes + Math.max(0, manifestEntries - 1) >
          MAX_WORKSPACE_MANIFEST_BYTES
        ) {
          throw workspaceInventoryError(
            "Cloud workspace manifest exceeds the 64 MiB limit; reduce eligible files or shorten their paths",
          );
        }
        if (eligibleBytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
          throw workspaceInventoryError(
            "Cloud workspace eligible content exceeds the 4 GiB limit; remove large eligible files or ignore them",
          );
        }
      };
      const addEntry = (entry: WorkerWorkspaceInventoryEntry): void => {
        if (manifestPaths.has(entry.path)) {
          return;
        }
        manifestPaths.add(entry.path);
        manifestPathBytes += Buffer.byteLength(entry.path);
        eligibleBytes +=
          entry.type === "file"
            ? entry.size
            : entry.type === "symlink"
              ? Buffer.byteLength(entry.target)
              : 0;
        manifestEntryBytes += Buffer.byteLength(JSON.stringify(entry));
        assertBudget();
      };
      const transferredPaths = new Set<string>();
      const writer = createInventoryPathWriter();
      const inspectFile = async (
        candidate: GitPathCandidate,
      ): Promise<WorkerWorkspaceManifestEntry | undefined> => {
        const file = candidate.name;
        if (isDerivedWorkspacePath(file, await isStagedInput(file))) {
          return undefined;
        }
        // A name Git reported that UTF-8 spelling cannot reproduce never reaches `lstat` as
        // itself, so probing the spelling silently dropped the file from the transfer list and
        // the capture published a manifest without it. Stop instead, naming the rename. This runs
        // before the decoded-name dedupe: a valid file spelled with U+FFFD can claim that name
        // first, and the dedupe would then hide the file that actually holds the invalid bytes.
        if (!gitPathIsDecodable(candidate)) {
          if (existingRawGitPath(canonicalRoot, candidate)) {
            throw workspaceInventoryError(WORKER_WORKSPACE_GIT_PATHS_UTF8_MESSAGE);
          }
          return undefined;
        }
        if (transferredPaths.has(file)) {
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
          return { path: file, type: "symlink", mode: 0o777, target: symlinkTarget };
        }
        return {
          path: file,
          type: "file",
          mode: gitFileMode(stats.mode),
          size: stats.size,
          sha256: "0".repeat(64),
        };
      };
      async function* candidates() {
        yield* readBoundedGitPathCandidates(params.eligiblePath);
        const selected = readBoundedGitPathCandidates(params.selectedPath);
        try {
          let selectedItem = await selected.next();
          for await (const candidate of readBoundedGitPathCandidates(params.ignoredPath)) {
            while (
              !selectedItem.done &&
              Buffer.compare(selectedItem.value.raw, candidate.raw) < 0
            ) {
              selectedItem = await selected.next();
            }
            if (
              (await isStagedInput(candidate.name)) ||
              (!selectedItem.done && selectedItem.value.raw.equals(candidate.raw))
            ) {
              yield candidate;
            }
          }
          while (!selectedItem.done) {
            selectedItem = await selected.next();
          }
        } finally {
          await selected.return(undefined);
        }
      }
      for await (const candidate of candidates()) {
        const entry = await inspectFile(candidate);
        if (!entry) {
          continue;
        }
        const file = candidate.name;
        transferredPaths.add(file);
        for (const ancestor of workspacePathAncestors(file)) {
          addEntry({ path: ancestor, type: "directory", mode: 0o700 });
        }
        addEntry(entry);
        transferPathBytes += Buffer.byteLength(file) + 1;
        assertBudget();
        const pendingWrite = writer.append(file);
        if (pendingWrite) {
          await pendingWrite;
        }
      }
      await writer.flush();
      return;
    }
    case "workspace.inventory.existing": {
      const params = command.input;
      const writer = createInventoryPathWriter();
      for await (const { name } of readBoundedGitPathCandidates(params.preparedListPath)) {
        let stats;
        try {
          stats = lstatSync(path.join(params.gitRoot, name));
        } catch (error) {
          if (!hasNodeErrorCode(error, "ENOENT")) {
            throw error;
          }
        }
        if (stats?.isFile() || stats?.isSymbolicLink()) {
          const pendingWrite = writer.append(name);
          if (pendingWrite) {
            await pendingWrite;
          }
        }
      }
      await writer.flush();
      return;
    }
    case "workspace.inventory.paths": {
      const paths = new Set<string>();
      for await (const { name } of readBoundedGitPathCandidates(command.input.filePath)) {
        paths.add(name);
      }
      return paths;
    }
  }
}
