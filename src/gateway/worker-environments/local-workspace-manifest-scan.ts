import { createHash } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { stagedInputPathDirectory } from "../../media/staged-inputs.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { selectLocalWorkspaceCanonicalPaths } from "./local-workspace-inventory.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
  updateLocalWorkspaceManifestTree,
  type LocalWorkspaceManifestChange,
  type LocalWorkspaceManifestNode,
  type LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";
import { scanActualWorkspaceManifest } from "./workspace-actual-manifest.js";
import { sameEntry } from "./workspace-manifest-comparison.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
import { buildCacheInputPaths } from "./workspace-path-exclusions.js";

export type LocalWorkspaceManifestAction =
  | { kind: "scan"; target: "canonical" | "projection"; canonicalRoot: string }
  | { kind: "materialize" };

export type LocalWorkspaceManifestScan = {
  version: 1;
  kind: "scan";
  previousRoot: string | null;
  resultingRoot: string;
  records: LocalWorkspaceManifestRecord[];
  observedRecords: LocalWorkspaceManifestRecord[];
  removed: string[];
  replace?: true;
  baseManifestRaw: string;
  baseManifestRef: string;
  currentManifestRaw: string;
  currentManifestRef: string;
  buildCacheInputs: string[];
};

export type LocalWorkspaceManifestCheckpoint = Omit<LocalWorkspaceManifestScan, "observedRecords">;

export type LocalWorkspaceManifestValue =
  | LocalWorkspaceManifestScan
  | { kind: "materialize"; rawManifest: string; manifestRef: string };

export type LocalWorkspaceManifestInput = {
  id: string;
  revision: number;
  action: LocalWorkspaceManifestAction;
};

/** Capture owner rows synchronously; filesystem discovery runs after this read scope closes. */
export function readLocalWorkspaceManifestRows(
  db: EngineConnection,
  input: LocalWorkspaceManifestInput,
) {
  const query = getNodeSqliteKysely<DB>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("local_workspace_projections")
      .select([
        "revision",
        "projection_path",
        "base_commit",
        "source_paths_json",
        "baseline_json",
        "baseline_ref",
      ])
      .where("worktree_id", "=", input.id),
  );
  if (!row || row.revision !== input.revision) {
    throw new Error("Local workspace binding changed");
  }
  const nodes = row.baseline_json
    ? []
    : executeSqliteQuerySync(
        db,
        query
          .selectFrom("local_workspace_manifest_nodes")
          .select("node_json")
          .where("worktree_id", "=", input.id),
      ).rows;
  return { row, nodes };
}

function manifestDocument(
  nodes: Iterable<LocalWorkspaceManifestNode>,
  baseCommit: string,
  retained?: string[],
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
  const rawManifest = serializeWorkerWorkspaceManifest(manifest);
  return {
    rawManifest,
    manifestRef: `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`,
  };
}

export async function executeLocalWorkspaceManifestRead(
  snapshot: ReturnType<typeof readLocalWorkspaceManifestRows>,
  action: LocalWorkspaceManifestAction,
): Promise<LocalWorkspaceManifestValue> {
  const { row } = snapshot;
  if (action.kind === "materialize" && row.baseline_json && row.baseline_ref) {
    // Pending legacy receipts name these exact bytes until acceptance migrates them.
    return { kind: "materialize", rawManifest: row.baseline_json, manifestRef: row.baseline_ref };
  }
  let records: Map<string, LocalWorkspaceManifestRecord>;
  if (row.baseline_json && row.baseline_ref) {
    const baseline = parseWorkerWorkspaceManifest(row.baseline_json, row.baseline_ref);
    records = createLocalWorkspaceManifestTree([
      ...baseline.entries,
      ...(baseline.directories ?? []).map((entryPath) => ({
        path: entryPath,
        type: "directory" as const,
      })),
    ]);
  } else {
    records = new Map();
    for (const { node_json } of snapshot.nodes) {
      // SAFETY: The workspace owner writes this internal record shape atomically with its root.
      const record = JSON.parse(node_json) as LocalWorkspaceManifestRecord;
      records.set(record.node.path, record);
    }
    if (records.size === 0) {
      if (row.baseline_ref) {
        throw new Error("Local workspace baseline nodes are missing");
      }
      records = createLocalWorkspaceManifestTree([]);
    }
  }
  if (action.kind === "materialize") {
    return {
      kind: "materialize",
      ...manifestDocument(
        Array.from(records.values(), ({ node }) => node).filter((node) => node.path !== ""),
        row.base_commit,
        // Stored nodes already passed admission, including derived-looking build inputs.
        [...buildCacheInputPaths(records.keys())],
      ),
    };
  }

  // The host index is authoritative for every operation. Guest Git metadata is never read.
  const canonicalPaths = await selectLocalWorkspaceCanonicalPaths({
    root: action.canonicalRoot,
    admittedPaths: row.source_paths_json,
    // This read has no effects; the lease owner revalidates before using its result.
    assertCurrent: () => undefined,
  });
  const retained = [...buildCacheInputPaths(canonicalPaths)];
  if (action.target === "projection") {
    for (const entryPath of records.keys()) {
      if (entryPath !== "") {
        canonicalPaths.add(entryPath);
      }
    }
  }
  const identityField = action.target === "canonical" ? "projectionIdentity" : "canonicalIdentity";
  const seen = new Set<string>();
  const identities = new Map<string, string>();
  const changes: LocalWorkspaceManifestChange[] = [];
  await scanActualWorkspaceManifest({
    root: action.target === "canonical" ? row.projection_path : action.canonicalRoot,
    baseCommit: row.base_commit,
    includePaths: action.target === "projection" ? canonicalPaths : undefined,
    buildCacheInputs: new Set(retained),
    reuseFile(entryPath, identity) {
      const previous = records.get(entryPath);
      return previous?.node.type === "file" && previous[identityField] === identity
        ? previous.node
        : undefined;
    },
    onEntry(node, identity) {
      seen.add(node.path);
      const previous = records.get(node.path);
      if (!sameEntry(previous?.node, node)) {
        changes.push({ path: node.path, node });
      }
      if (identity !== undefined && previous?.[identityField] !== identity) {
        identities.set(node.path, identity);
      }
    },
  });
  for (const entryPath of records.keys()) {
    if (entryPath !== "" && !seen.has(entryPath)) {
      changes.push({ path: entryPath });
    }
  }
  const inspected = new Set<string>();
  for (const change of changes) {
    inspected.add(change.path);
    for (const ancestor of workspacePathAncestors(change.path)) {
      inspected.add(ancestor);
    }
    const stagedDirectory = stagedInputPathDirectory(change.path);
    if (stagedDirectory) {
      // Partial documents still need the unchanged ownership marker to admit derived-name inputs.
      inspected.add(`${stagedDirectory}/.gitignore`);
      for (const ancestor of workspacePathAncestors(`${stagedDirectory}/.gitignore`)) {
        inspected.add(ancestor);
      }
    }
  }
  const previousNodes: LocalWorkspaceManifestNode[] = [];
  for (const entryPath of inspected) {
    const previous = records.get(entryPath);
    if (previous) {
      previousNodes.push(previous.node);
    }
  }
  const updated = updateLocalWorkspaceManifestTree(records, changes);
  const changedRecords = new Map(updated.records.map((record) => [record.node.path, record]));
  const observedRecords: LocalWorkspaceManifestRecord[] = [];
  for (const [entryPath, identity] of identities) {
    const previous = records.get(entryPath)!;
    const record = { ...previous, [identityField]: identity };
    records.set(entryPath, record);
    if (changedRecords.has(entryPath)) {
      changedRecords.set(entryPath, record);
    } else {
      observedRecords.push(record);
    }
  }
  const currentNodes: LocalWorkspaceManifestNode[] = [];
  for (const entryPath of inspected) {
    const current = records.get(entryPath);
    if (current) {
      currentNodes.push(current.node);
    }
  }
  const base = manifestDocument(previousNodes, row.base_commit, retained);
  const current = manifestDocument(currentNodes, row.base_commit, retained);
  const replace = row.baseline_json !== null || row.baseline_ref === null;
  return {
    version: 1,
    kind: "scan",
    previousRoot: row.baseline_ref,
    resultingRoot: localWorkspaceManifestRootReference(records, row.base_commit),
    records: [...(replace ? records : changedRecords).values()],
    observedRecords: replace ? [] : observedRecords,
    removed: updated.removed,
    ...(replace ? { replace: true } : {}),
    baseManifestRaw: base.rawManifest,
    baseManifestRef: base.manifestRef,
    currentManifestRaw: current.rawManifest,
    currentManifestRef: current.manifestRef,
    buildCacheInputs: retained,
  };
}
