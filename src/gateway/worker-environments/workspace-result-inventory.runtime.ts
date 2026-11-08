import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runGitBuffered } from "../../agents/worktrees/git.js";
import { ownedWorkerBytes } from "../../infra/worker-transfer-bytes.js";
import { isStagedInputPath, stagedInputDirectoriesFromEntries } from "../../media/staged-inputs.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import { WorkspaceResultLimitError } from "./workspace-inventory-limits.js";
import { manifestNodes, parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import {
  MAX_RECONCILIATION_FILE_BYTES,
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath, buildCacheInputPaths } from "./workspace-path-exclusions.js";
import { reconciliationEntries } from "./workspace-reconcile-derived-paths.js";
import { WORKSPACE_RESULT_GIT_TIMEOUT_MS as PATCH_TIMEOUT_MS } from "./workspace-result-git.js";
import {
  requireWorkerResultStorageRef,
  resolveStagedWorkspaceReadEntry,
  stagedWorkspaceEntryBytes,
  STAGED_WORKSPACE_READ_MAX_BYTES,
  STAGED_WORKSPACE_READ_MAX_ENTRIES,
  STAGED_RESULT_MESSAGE,
  WorkerWorkspaceGitHistorySchema,
  type StagedWorkerArtifactInventory,
  type StagedWorkerWorkspaceInventory,
  type StagedWorkerWorkspaceReadEntry,
  type WorkspaceArtifactReadOperations,
} from "./workspace-result-inventory.js";

const STAGED_RESULT_METADATA_LIMIT = 128 * 1024 * 1024 + 4_096;

export async function loadStagedWorkerWorkspace(
  root: string,
  stagedResultRef: string,
  buildCacheInputs?: string[],
  reconciliation?: { baseManifestRef: string; alreadyAccepted?: boolean },
): Promise<
  Omit<StagedWorkerWorkspaceInventory, "reconciliation"> & {
    nodes: {
      baseNodes: ReturnType<typeof manifestNodes>;
      currentNodes: ReturnType<typeof manifestNodes>;
    };
  }
> {
  const ref = requireWorkerResultStorageRef(stagedResultRef);
  const rawCommit = await runGitBuffered(root, ["cat-file", "commit", ref], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: STAGED_RESULT_METADATA_LIMIT,
  });
  if (rawCommit.termination === "output-limit") {
    throw new WorkspaceResultLimitError(
      "Worker workspace result metadata exceeds its 128 MiB safety limit.",
    );
  }
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
  const version =
    lines[1] === "version 1"
      ? 1
      : lines[1] === "version 2"
        ? 2
        : lines[1] === "version 3"
          ? 3
          : undefined;
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
    lines.length !== (version === 3 ? 7 : 6) ||
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
  const base = parseWorkerWorkspaceManifest(baseRaw, baseManifestRef, buildCacheInputs);
  const current = parseWorkerWorkspaceManifest(currentRaw, currentManifestRef, buildCacheInputs);
  const gitHistory =
    version === 3 && lines[6]?.startsWith("git-history ")
      ? WorkerWorkspaceGitHistorySchema.parse(JSON.parse(lines[6].slice("git-history ".length)))
      : undefined;
  if (
    version === 3 &&
    (!gitHistory ||
      gitHistory.baseCommit !== base.baseCommit ||
      (gitHistory.descendsFromBase &&
        !gitHistory.unavailableReason &&
        !rawCommit.stdout
          .subarray(0, commitHeaderEnd)
          .toString("utf8")
          .split("\n")
          .includes(`parent ${gitHistory.headCommit}`)))
  ) {
    throw new Error("Cloud workspace staged Git history is invalid");
  }
  // Inspect accepted receipts without replaying them. Unapplied historical results
  // must pass the same admission as new publication before materializing any files.
  const nodes = { baseNodes: manifestNodes(base), currentNodes: manifestNodes(current) };
  const changedResult = parseChangedWorkspaceResult(
    base,
    current,
    Boolean(
      reconciliation &&
      !reconciliation.alreadyAccepted &&
      reconciliation.baseManifestRef === baseManifestRef,
    ),
    nodes,
  );
  const changedEntries = changedResult.entries;
  const treeEntries =
    version === 1
      ? reconciliationEntries(current.entries, undefined, buildCacheInputs)
      : changedEntries;
  const tree = await runGitBuffered(root, ["ls-tree", "-r", "-z", "--full-tree", ref], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: 2 * MAX_RECONCILIATION_FILE_BYTES,
  });
  if (tree.termination !== "exit" || tree.code !== 0) {
    throw new Error(tree.stderr.toString("utf8").trim() || "git ls-tree failed");
  }
  const stagedInputs = stagedInputDirectoriesFromEntries(current.entries);
  const retained = buildCacheInputPaths(buildCacheInputs);
  const objectsByPath = new Map<string, { mode: string; objectId: string }>();
  for (const record of tree.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const parsed = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(
      record,
    );
    if (!parsed) {
      throw new Error("Cloud workspace staged result tree is invalid");
    }
    const entryPath = parsed[3]!;
    // Older receipts can contain caches that the authenticated manifest reader
    // now excludes. Apply the same rule without rewriting the retained result.
    if (
      isDerivedWorkspacePath(
        entryPath,
        retained.has(entryPath) || isStagedInputPath(entryPath, stagedInputs),
        buildCacheInputs !== undefined,
      )
    ) {
      continue;
    }
    objectsByPath.set(entryPath, { mode: parsed[1]!, objectId: parsed[2]! });
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
    ...(gitHistory ? { gitHistory } : {}),
    baseManifestRaw: baseRaw,
    currentManifestRaw: currentRaw,
    baseManifestRef,
    currentManifestRef,
    base,
    current,
    nodes,
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
  if (bytes > STAGED_WORKSPACE_READ_MAX_BYTES) {
    throw new Error("Cloud workspace staged result batch exceeds its byte limit");
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
  return contents.length === 1 ? contents[0]! : Buffer.concat(contents);
}

/** The private staging directory is host-owned; decoded inventories never cross this boundary. */
export async function materializeStagedWorkerWorkspace(
  root: string,
  stagingRoot: string | undefined,
  snapshot: Pick<StagedWorkerWorkspaceInventory, "changedEntries" | "objectsByPath">,
): Promise<void> {
  let nextEntry = 0;
  while (nextEntry < snapshot.changedEntries.length) {
    const entries: StagedWorkerWorkspaceReadEntry[] = [];
    let bytes = 0;
    while (nextEntry < snapshot.changedEntries.length) {
      const entry = snapshot.changedEntries[nextEntry]!;
      const size = stagedWorkspaceEntryBytes(entry);
      if (
        entries.length === STAGED_WORKSPACE_READ_MAX_ENTRIES ||
        (entries.length > 0 && bytes + size > STAGED_WORKSPACE_READ_MAX_BYTES)
      ) {
        break;
      }
      entries.push(resolveStagedWorkspaceReadEntry(snapshot.objectsByPath, entry));
      bytes += size;
      nextEntry++;
    }
    const contents = await readStagedWorkerWorkspaceEntries({ root, entries });
    if (!stagingRoot) {
      continue;
    }
    let offset = 0;
    const tasks = entries.map(({ entry }) => {
      const content =
        entry.type === "file" ? contents.subarray(offset, offset + entry.size) : undefined;
      offset += entry.type === "file" ? entry.size : 0;
      return async () => {
        const target = path.join(stagingRoot, entry.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        if (entry.type === "symlink") {
          await fs.symlink(entry.target, target);
        } else {
          await fs.writeFile(target, content!, { mode: entry.mode, flag: "wx" });
          await fs.chmod(target, entry.mode);
        }
      };
    });
    const result = await runTasksWithConcurrency({ tasks, limit: 4, errorMode: "stop" });
    if (result.hasError) {
      throw result.firstError;
    }
  }
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
  const download = snapshot.changedEntries.find((entry) => entry.path === input.downloadPath);
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
    ...(preview === undefined ? {} : { preview: ownedWorkerBytes(preview) }),
    ...(download?.type === "file"
      ? { downloadObjectId: snapshot.objectsByPath.get(download.path)!.objectId }
      : {}),
  };
}
