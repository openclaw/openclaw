import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { isStringArray } from "@openclaw/normalization-core/record-coerce";
import { splitNullBuffer } from "../../agents/worktrees/git-path-inventory.js";
import { requireGitBuffer } from "../../agents/worktrees/git.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import type {
  LocalWorkspaceManifestRecord,
  LocalWorkspaceManifestNode,
} from "./local-workspace-manifest-tree.js";
import type {
  LocalWorkspaceManifestValue,
  LocalWorkspaceProjection,
} from "./local-workspace-store.types.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkspaceManifestPathPolicy,
} from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
import { buildCacheInputPaths } from "./workspace-path-exclusions.js";

function decodeLocalWorkspaceGitPaths(listed: Buffer): string[] {
  if (!isUtf8(listed)) {
    throw new Error(
      "Local sandbox source paths must be UTF-8; rename the invalid Git path before retrying",
    );
  }
  return listed.toString("utf8").split("\0").filter(Boolean);
}

export function parseLocalWorkspaceSourcePaths(value: string): string[] {
  const paths: unknown = JSON.parse(value);
  if (!isStringArray(paths)) {
    throw new Error("Invalid local workspace source admission");
  }
  return paths;
}

/** Read guest ignore files with the host's index/config, never guest Git metadata. */
export async function readLocalWorkspaceIgnoredPaths(root: string, projection: string) {
  const listed = await requireGitBuffer(root, [
    `--work-tree=${projection}`,
    "ls-files",
    "--full-name",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  return new Set(decodeLocalWorkspaceGitPaths(listed));
}

/** Admit untracked source once, before any guest can change canonical ignore rules. */
export async function admitLocalWorkspaceSourcePaths(params: {
  root: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<string> {
  const listed = await requireGitBuffer(
    params.root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { signal: params.signal, beforeRun: params.assertCurrent },
  );
  params.assertCurrent();
  return JSON.stringify([...new Set(decodeLocalWorkspaceGitPaths(listed))]);
}

/** Ignore changes are source edits, not authority to enroll canonical-only bytes. */
export async function selectLocalWorkspaceCanonicalPaths(params: {
  root: string;
  admittedPaths?: readonly string[];
  // Reuse authoritative host inputs read earlier in this operation.
  preparedPaths?: ReadonlySet<string>;
  baselinePaths?: ReadonlySet<string>;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<Set<string>> {
  params.signal?.throwIfAborted();
  params.assertCurrent();
  let paths: Set<string>;
  if (params.preparedPaths) {
    paths = new Set(params.preparedPaths);
  } else {
    const listed = await requireGitBuffer(params.root, ["ls-files", "--cached", "-z"], {
      signal: params.signal,
      beforeRun: params.assertCurrent,
    });
    params.assertCurrent();
    // Only the host owns this index; the guest has independent Git metadata. A
    // host can deliberately admit a new path with git add, even if it is ignored.
    paths = new Set(params.admittedPaths);
    for (const entryPath of decodeLocalWorkspaceGitPaths(listed)) {
      paths.add(entryPath);
    }
  }
  if (params.baselinePaths) {
    for (const entryPath of params.baselinePaths) {
      paths.add(entryPath);
    }
  }
  // Set iteration visits added parents too, so each path needs only its immediate
  // parent to include every ancestor omitted by Git or accepted from the guest.
  for (const entryPath of paths) {
    const separator = entryPath.lastIndexOf("/");
    if (separator !== -1) {
      paths.add(entryPath.slice(0, separator));
    }
  }
  return paths;
}

export async function prepareLocalWorkspaceBuildInputs(params: {
  worktree: Pick<ManagedWorktreeRecord, "path" | "repoRoot" | "removedAt" | "snapshotRef">;
  projection: Pick<LocalWorkspaceProjection, "source_paths_json" | "baseline_ref">;
  signal: AbortSignal;
  assertCurrent: () => void;
  retainSourcePaths: (sourcePaths: string) => Promise<void>;
}) {
  const { worktree, projection, signal, assertCurrent } = params;
  const admitted = parseLocalWorkspaceSourcePaths(projection.source_paths_json);
  const paths =
    worktree.removedAt === undefined
      ? await selectLocalWorkspaceCanonicalPaths({
          root: worktree.path,
          admittedPaths: admitted,
          signal,
          assertCurrent,
        })
      : new Set(admitted);
  const retained = buildCacheInputPaths(paths);
  if (worktree.snapshotRef && projection.baseline_ref) {
    const archived = await requireGitBuffer(
      worktree.repoRoot,
      ["ls-tree", "-r", "-z", "--name-only", worktree.snapshotRef],
      { signal, beforeRun: assertCurrent },
    );
    assertCurrent();
    // Older archives lost later index membership. The snapshot owns these exact
    // inputs, including derived-looking names, but not future directory contents.
    for (const entryPath of buildCacheInputPaths(decodeLocalWorkspaceGitPaths(archived))) {
      retained.add(entryPath);
      paths.add(entryPath);
    }
  }
  // Keep acquired input custody when later recovery no longer has the checkout or archive.
  if (retained.size) {
    const admittedCount = admitted.length;
    const known = new Set(admitted);
    for (const entryPath of retained) {
      if (!known.has(entryPath)) {
        admitted.push(entryPath);
      }
    }
    if (admitted.length > admittedCount) {
      await params.retainSourcePaths(JSON.stringify(admitted));
    }
  }
  return {
    paths,
    retained: [...retained],
  };
}

type ArchiveBaselineInput = {
  root: string;
  snapshotCommit: string;
  manifest: WorkerWorkspaceManifest;
  signal?: AbortSignal;
  assertCurrent: () => void;
};

/** Git archives omit accepted ignored leaves and empty directories; retain that overlay separately. */
async function selectArchiveManifest(params: ArchiveBaselineInput) {
  const { signal, assertCurrent } = params;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(params.snapshotCommit)) {
    throw new Error("Invalid archive snapshot commit");
  }
  const listed = await requireGitBuffer(
    params.root,
    ["ls-tree", "-r", "-z", "--name-only", params.snapshotCommit],
    {
      signal,
      beforeRun: assertCurrent,
      maxOutputBytes: 64 * 1024 * 1024,
    },
  );
  assertCurrent();
  const paths = new Set(splitNullBuffer(listed).map((entry) => entry.toString("hex")));
  const entries = params.manifest.entries.filter((entry) =>
    paths.has(Buffer.from(entry.path).toString("hex")),
  );
  const directories = new Set<string>();
  for (const entry of entries) {
    for (const parent of workspacePathAncestors(entry.path)) {
      directories.add(parent);
    }
  }
  if (
    entries.length === params.manifest.entries.length &&
    directories.size === (params.manifest.directories?.length ?? 0) &&
    params.manifest.directories?.every((directory) => directories.has(directory)) !== false
  ) {
    return params.manifest;
  }
  return {
    ...params.manifest,
    entries,
    directories: [...directories].toSorted(),
  };
}

export function localWorkspaceManifestDocument(
  nodes: Iterable<LocalWorkspaceManifestNode>,
  baseCommit: string,
  retained?: string[],
  pathPolicy: WorkspaceManifestPathPolicy = "current",
) {
  const manifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit,
    entries: [],
    directories: [],
    ...(retained ? { buildCacheInputs: retained } : {}),
  };
  for (const node of nodes) {
    if (node.type === "directory") {
      manifest.directories!.push(node.path);
    } else {
      manifest.entries.push(node);
    }
  }
  return archiveDocument(manifest, pathPolicy);
}

function archiveDocument(
  manifest: WorkerWorkspaceManifest,
  pathPolicy: WorkspaceManifestPathPolicy = "current",
) {
  const rawManifest = serializeWorkerWorkspaceManifest(manifest, pathPolicy);
  return {
    rawManifest,
    manifestRef: "sha256:" + createHash("sha256").update(rawManifest).digest("hex"),
  };
}

export async function captureLocalWorkspaceArchiveBaseline(params: ArchiveBaselineInput) {
  return archiveDocument(await selectArchiveManifest(params));
}

/** The worker consumes admitted nodes; full receipt bytes are needed only for an overlay. */
export async function prepareLocalWorkspaceArchive(params: {
  root: string;
  snapshotCommit: string;
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>;
  baseCommit: string;
  buildCacheInputs: string[];
}): Promise<Extract<LocalWorkspaceManifestValue, { kind: "archive" }>> {
  const manifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit: params.baseCommit,
    buildCacheInputs: params.buildCacheInputs,
    entries: [],
    directories: [],
  };
  for (const { node } of params.records.values()) {
    if (node.type !== "directory") {
      manifest.entries.push(node);
    } else if (node.path !== "") {
      manifest.directories!.push(node.path);
    }
  }
  const base = await selectArchiveManifest({ ...params, manifest, assertCurrent: () => undefined });
  return base === manifest
    ? { kind: "archive" }
    : {
        kind: "archive",
        overlay: { base: archiveDocument(base), accepted: archiveDocument(manifest) },
      };
}
