import { createHash } from "node:crypto";
import { runGitBuffered } from "../../agents/worktrees/git.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../server-methods/workspace-fs.js";
import { parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import {
  MAX_RECONCILIATION_FILE_BYTES,
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { reconciliationEntries } from "./workspace-reconcile-derived-paths.js";
import { WORKSPACE_RESULT_GIT_TIMEOUT_MS as PATCH_TIMEOUT_MS } from "./workspace-result-git.js";
import {
  requireWorkerResultStorageRef,
  resolveStagedWorkspaceReadEntry,
  stagedWorkspaceEntryBytes,
  STAGED_WORKSPACE_READ_MAX_BYTES,
  STAGED_WORKSPACE_READ_MAX_ENTRIES,
  STAGED_RESULT_MESSAGE,
  type StagedWorkerArtifactInventory,
  type StagedWorkerWorkspaceInventory,
  type StagedWorkerWorkspaceReadEntry,
  type WorkspaceArtifactReadOperations,
} from "./workspace-result-inventory.js";

const STAGED_RESULT_METADATA_LIMIT = 128 * 1024 * 1024 + 4_096;

async function readGitBlob(params: {
  root: string;
  objectId: string;
  maxBytes: number;
}): Promise<Buffer> {
  const result = await runGitBuffered(params.root, ["cat-file", "blob", params.objectId], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: params.maxBytes + 1,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  if (result.stdout.byteLength > params.maxBytes) {
    throw new Error("Cloud workspace staged result exceeds its byte limit");
  }
  return result.stdout;
}

export async function loadStagedWorkerWorkspace(
  root: string,
  stagedResultRef: string,
): Promise<StagedWorkerWorkspaceInventory> {
  const ref = requireWorkerResultStorageRef(stagedResultRef);
  const rawCommit = await runGitBuffered(root, ["cat-file", "commit", ref], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: STAGED_RESULT_METADATA_LIMIT,
  });
  if (rawCommit.termination !== "exit" || rawCommit.code !== 0) {
    throw new Error(rawCommit.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  const commitHeaderEnd = rawCommit.stdout.indexOf("\n\n");
  if (commitHeaderEnd < 0) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const message = rawCommit.stdout.subarray(commitHeaderEnd + 2);
  const metadataEnd = message.indexOf("\n\n");
  if (metadataEnd < 0) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const lines = message.subarray(0, metadataEnd).toString("utf8").split("\n");
  const version = lines[1] === "version 1" ? 1 : lines[1] === "version 2" ? 2 : undefined;
  const match = /^sha256:[a-f0-9]{64}$/u;
  const baseManifestRef = lines[2]?.slice("base-ref ".length) ?? "";
  const currentManifestRef = lines[3]?.slice("current-ref ".length) ?? "";
  const baseBytes = Number(lines[4]?.slice("base-bytes ".length));
  const currentBytes = Number(lines[5]?.slice("current-bytes ".length));
  if (
    lines[0] !== STAGED_RESULT_MESSAGE ||
    version === undefined ||
    !lines[2]?.startsWith("base-ref ") ||
    !lines[3]?.startsWith("current-ref ") ||
    !lines[4]?.startsWith("base-bytes ") ||
    !lines[5]?.startsWith("current-bytes ") ||
    lines.length !== 6 ||
    !match.test(baseManifestRef) ||
    !match.test(currentManifestRef) ||
    !Number.isSafeInteger(baseBytes) ||
    baseBytes < 0 ||
    !Number.isSafeInteger(currentBytes) ||
    currentBytes < 0
  ) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const manifests = message.subarray(metadataEnd + 2);
  if (manifests.byteLength !== baseBytes + currentBytes) {
    throw new Error("Cloud workspace staged result metadata is truncated");
  }
  const baseRaw = manifests.subarray(0, baseBytes).toString("utf8");
  const currentRaw = manifests.subarray(baseBytes).toString("utf8");
  const base = parseWorkerWorkspaceManifest(baseRaw, baseManifestRef);
  const current = parseWorkerWorkspaceManifest(currentRaw, currentManifestRef);
  // Shipped v1 refs carry a complete current tree and predate the conservative
  // manifest worst-case record gate. Recovery still validates their manifests,
  // tree shape, and changed payload bytes; the apply owner caps actual records.
  const changedResult = parseChangedWorkspaceResult(base, current, version !== 1);
  const changedEntries = changedResult.entries;
  const treeEntries = version === 1 ? reconciliationEntries(current.entries) : changedEntries;
  const tree = await runGitBuffered(root, ["ls-tree", "-r", "-z", "--full-tree", ref], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: 2 * MAX_RECONCILIATION_FILE_BYTES,
  });
  if (tree.termination !== "exit" || tree.code !== 0) {
    throw new Error(tree.stderr.toString("utf8").trim() || "git ls-tree failed");
  }
  const objectsByPath = new Map<string, { mode: string; objectId: string }>();
  for (const record of tree.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const parsed = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(
      record,
    );
    if (!parsed) {
      throw new Error("Cloud workspace staged result tree is invalid");
    }
    objectsByPath.set(parsed[3]!, { mode: parsed[1]!, objectId: parsed[2]! });
  }
  if (objectsByPath.size !== treeEntries.length) {
    throw new Error("Cloud workspace staged result tree does not match its manifest");
  }
  for (const entry of treeEntries) {
    const object = objectsByPath.get(entry.path);
    const expectedMode =
      entry.type === "symlink" ? "120000" : (entry.mode & 0o111) !== 0 ? "100755" : "100644";
    if (!object || object.mode !== expectedMode) {
      throw new Error(`Cloud workspace staged result tree is invalid: ${entry.path}`);
    }
  }
  return {
    baseManifestRaw: baseRaw,
    currentManifestRaw: currentRaw,
    baseManifestRef,
    currentManifestRef,
    base,
    current,
    changed: changedResult.changed,
    changedEntries,
    objectsByPath,
  };
}

function assertStagedEntryContent(entry: WorkerWorkspaceManifestEntry, content: Buffer): void {
  const matches =
    entry.type === "symlink"
      ? content.toString("utf8") === entry.target
      : content.byteLength === entry.size &&
        createHash("sha256").update(content).digest("hex") === entry.sha256;
  if (!matches) {
    throw new Error(`Cloud workspace staged result payload is invalid: ${entry.path}`);
  }
}

export async function readStagedWorkerWorkspaceEntries(params: {
  root: string;
  entries: readonly StagedWorkerWorkspaceReadEntry[];
}): Promise<Buffer> {
  if (params.entries.length > STAGED_WORKSPACE_READ_MAX_ENTRIES) {
    throw new Error("Cloud workspace staged result batch exceeds its entry limit");
  }
  let bytes = 0;
  for (const { object, entry } of params.entries) {
    const size = stagedWorkspaceEntryBytes(entry);
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object.objectId) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_RECONCILIATION_FILE_BYTES
    ) {
      throw new Error(`Cloud workspace staged result payload is invalid: ${entry.path}`);
    }
    bytes += size;
  }
  if (params.entries.length > 1 && bytes > STAGED_WORKSPACE_READ_MAX_BYTES) {
    throw new Error("Cloud workspace staged result batch exceeds its byte limit");
  }
  const only = params.entries.length === 1 ? params.entries[0] : undefined;
  if (only) {
    const content = await readGitBlob({
      root: params.root,
      objectId: only.object.objectId,
      maxBytes: MAX_RECONCILIATION_FILE_BYTES,
    });
    assertStagedEntryContent(only.entry, content);
    return only.entry.type === "file" ? content : Buffer.alloc(0);
  }
  if (params.entries.length === 0) {
    return Buffer.alloc(0);
  }

  // Only verified OIDs enter the line protocol; filenames remain in the manifest.
  const result = await runGitBuffered(params.root, ["cat-file", "--batch"], {
    input: Buffer.from(params.entries.map(({ object }) => `${object.objectId}\n`).join("")),
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: bytes + params.entries.length * 128 + 1,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  const contents: Buffer[] = [];
  let offset = 0;
  for (const { object, entry } of params.entries) {
    const headerEnd = result.stdout.indexOf(0x0a, offset);
    const header =
      headerEnd >= offset && headerEnd - offset <= 128
        ? /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/u.exec(
            result.stdout.subarray(offset, headerEnd).toString("utf8"),
          )
        : null;
    const size = Number(header?.[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (
      header?.[1] !== object.objectId ||
      !Number.isSafeInteger(size) ||
      size > MAX_RECONCILIATION_FILE_BYTES ||
      (entry.type === "file" && size !== entry.size) ||
      contentEnd >= result.stdout.byteLength ||
      result.stdout[contentEnd] !== 0x0a
    ) {
      throw new Error(`Cloud workspace staged result payload is invalid: ${entry.path}`);
    }
    const content = result.stdout.subarray(contentStart, contentEnd);
    assertStagedEntryContent(entry, content);
    if (entry.type === "file") {
      contents.push(content);
    }
    offset = contentEnd + 1;
  }
  if (offset !== result.stdout.byteLength) {
    throw new Error("Cloud workspace staged result contains unexpected payload bytes");
  }
  // Links are validated above; their filesystem representation uses the manifest target.
  return Buffer.concat(contents);
}

export async function collectStagedWorkerArtifacts(
  input: WorkspaceArtifactReadOperations["workspace.artifacts"]["input"],
): Promise<StagedWorkerArtifactInventory> {
  const snapshot = await loadStagedWorkerWorkspace(input.root, input.ref);
  const currentPaths = new Set(snapshot.current.entries.map((entry) => entry.path));
  const basePaths = new Set(snapshot.base.entries.map((entry) => entry.path));
  const changes: StagedWorkerArtifactInventory["changes"] = [
    ...snapshot.changedEntries.map((entry) => ({
      path: entry.path,
      status: basePaths.has(entry.path) ? ("modified" as const) : ("added" as const),
      additions: 0,
      deletions: 0,
    })),
    ...snapshot.base.entries
      .filter((entry) => !currentPaths.has(entry.path))
      .map((entry) => ({
        path: entry.path,
        status: "deleted" as const,
        additions: 0,
        deletions: 0,
      })),
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  const selected = snapshot.changedEntries.find((entry) => entry.path === input.previewPath);
  const preview =
    selected?.type === "file" && selected.size <= WORKSPACE_PREVIEW_MAX_BYTES
      ? await readStagedWorkerWorkspaceEntries({
          root: input.root,
          entries: [resolveStagedWorkspaceReadEntry(snapshot.objectsByPath, selected)],
        })
      : undefined;
  return {
    baseManifestRef: snapshot.baseManifestRef,
    currentManifestRef: snapshot.currentManifestRef,
    base: { baseCommit: snapshot.base.baseCommit },
    current: { baseCommit: snapshot.current.baseCommit },
    changedEntries: snapshot.changedEntries,
    changes,
    ...(preview === undefined ? {} : { preview }),
  };
}
