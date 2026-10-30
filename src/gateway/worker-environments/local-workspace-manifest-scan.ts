import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { deflateRawSync } from "node:zlib";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { stagedInputPathDirectory } from "../../media/staged-inputs.js";
import { shellEscape } from "../../shared/shell-quote.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  localWorkspaceDigestBytes,
  localWorkspaceDigestReference,
  prepareLocalWorkspaceTreePacks,
} from "./local-workspace-cas.js";
import {
  readLocalWorkspaceSourcePaths,
  readLocalWorkspaceTree,
} from "./local-workspace-cas.kernel.js";
import { prepareLocalWorkspaceFingerprints } from "./local-workspace-fingerprints.js";
import {
  parseLocalWorkspaceSourcePaths,
  selectLocalWorkspaceCanonicalPaths,
} from "./local-workspace-inventory.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
  updateLocalWorkspaceManifestTree,
  type LocalWorkspaceManifestChange,
  type LocalWorkspaceManifestNode,
  type LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";
import type {
  LocalWorkspaceManifestMutation,
  LocalWorkspaceManifestScan,
  LocalWorkspaceManifestValue,
  LocalWorkspaceMutation,
  LocalWorkspacePreparedUpdate,
} from "./local-workspace-store.types.js";
import { scanActualWorkspaceManifest } from "./workspace-actual-manifest.js";
import { sameEntry } from "./workspace-manifest-comparison.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkspaceManifestPathPolicy,
} from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
import { buildCacheInputPaths } from "./workspace-path-exclusions.js";

export type LocalWorkspaceBaselineDocument = {
  rawManifest: string;
  manifestRef: string;
  buildCacheInputs: string[];
};

export type LocalWorkspaceManifestAction =
  | { kind: "scan"; target: "canonical" | "projection"; canonicalRoot: string }
  | { kind: "materialize" }
  | { kind: "convert" }
  | { kind: "repair"; canonicalRoot: string }
  | {
      kind: "prepare";
      manifest: LocalWorkspaceManifestMutation;
      patch: Extract<LocalWorkspaceMutation, { kind: "update" }>["patch"];
    }
  | (LocalWorkspaceBaselineDocument & {
      kind: "replace";
      patch: Extract<LocalWorkspaceMutation, { kind: "update" }>["patch"];
    });

export type LocalWorkspaceManifestCheckpoint = Omit<
  LocalWorkspaceManifestScan,
  "observation" | "preparations"
>;

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
  return runSqliteReadSnapshotSync(db, () => readManifestRowsInSnapshot(db, input));
}

function readManifestRowsInSnapshot(db: EngineConnection, input: LocalWorkspaceManifestInput) {
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
        "tree_root_digest",
        "source_paths_digest",
        "canonical_fingerprints",
        "projection_fingerprints",
        "pending_ref",
      ])
      .$if(input.action.kind === "repair", (builder) => builder.select("checkpoint_json"))
      .where("worktree_id", "=", input.id),
  );
  if (!row || row.revision !== input.revision) {
    throw new Error("Local workspace binding changed");
  }
  if (row.source_paths_digest) {
    row.source_paths_json = readLocalWorkspaceSourcePaths(db, row.source_paths_digest);
  }
  let records = new Map<string, LocalWorkspaceManifestRecord>();
  const replacing =
    input.action.kind === "replace" ||
    input.action.kind === "repair" ||
    (input.action.kind === "prepare" && input.action.manifest.replace);
  if (row.tree_root_digest && (!replacing || input.action.kind === "repair")) {
    records = readLocalWorkspaceTree(db, row.tree_root_digest, {
      allowMissing: input.action.kind === "repair",
    });
  } else if (!row.baseline_json && !replacing) {
    // Decode within the read scope; do not retain the JSON inventory beside its tree during scanning.
    for (const { node_json } of executeSqliteQuerySync(
      db,
      query
        .selectFrom("local_workspace_manifest_nodes")
        .select("node_json")
        .where("worktree_id", "=", input.id),
    ).rows) {
      // SAFETY: The workspace owner writes this internal record shape atomically with its root.
      const record = JSON.parse(node_json) as LocalWorkspaceManifestRecord;
      records.set(record.node.path, record);
    }
  }
  return { row, records };
}

function manifestDocument(
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
  const rawManifest = serializeWorkerWorkspaceManifest(manifest, pathPolicy);
  return {
    rawManifest,
    manifestRef: `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`,
  };
}

function prepareUpdate(
  mutation: Extract<LocalWorkspaceMutation, { kind: "update" }>,
  preparations: Uint8Array[] = [],
): LocalWorkspacePreparedUpdate {
  const manifest = mutation.manifest;
  const patch = {
    ...mutation.patch,
    ...(manifest ? { baseline_ref: manifest.resultingRoot, baseline_json: null } : {}),
    ...(manifest?.treeRoot
      ? { tree_root_digest: localWorkspaceDigestBytes(manifest.treeRoot) }
      : {}),
    ...(manifest?.fingerprints
      ? {
          [manifest.fingerprints.target === "canonical"
            ? "canonical_fingerprints"
            : "projection_fingerprints"]: Buffer.from(manifest.fingerprints.blob, "base64"),
        }
      : {}),
  };
  return {
    revision: mutation.revision,
    patch,
    mutation: deflateRawSync(serialize({ ...mutation, patch })),
    preparations,
  };
}

export async function executeLocalWorkspaceManifestRead(
  snapshot: ReturnType<typeof readLocalWorkspaceManifestRows>,
  action: LocalWorkspaceManifestAction,
): Promise<LocalWorkspaceManifestValue> {
  const { row } = snapshot;
  if (action.kind === "repair") {
    if (!row.baseline_ref) {
      throw new Error("Local workspace repair requires its saved baseline reference");
    }
    const expectedRoot = row.tree_root_digest
      ? localWorkspaceDigestReference(row.tree_root_digest)
      : row.baseline_ref;
    const retained = buildCacheInputPaths(parseLocalWorkspaceSourcePaths(row.source_paths_json));
    // A pending receipt can name an intact result after both live sides have
    // moved beyond the baseline. Its saved delta can reconstruct the merge base.
    const checkpoint = row.checkpoint_json
      ? (JSON.parse(row.checkpoint_json) as LocalWorkspaceManifestCheckpoint) // SAFETY: Owner-written checkpoint.
      : undefined;
    const documents = checkpoint
      ? [
          parseWorkerWorkspaceManifest(
            checkpoint.baseManifestRaw,
            checkpoint.baseManifestRef,
            [...retained],
            "stored",
          ),
          parseWorkerWorkspaceManifest(
            checkpoint.currentManifestRaw,
            checkpoint.currentManifestRef,
            [...retained],
            "stored",
          ),
        ].map(
          (manifest) =>
            new Map<string, LocalWorkspaceManifestNode>([
              ...manifest.entries.map((node) => [node.path, node] as const),
              ...(manifest.directories ?? []).map(
                (entryPath) =>
                  [entryPath, { path: entryPath, type: "directory" as const }] as const,
              ),
            ]),
        )
      : [];
    // Surviving saved-root records supply membership, not reconstructed content.
    // Every candidate is scanned afresh and authenticated by the exact saved root.
    const baselinePaths = new Set(snapshot.records.keys());
    baselinePaths.delete("");
    const knownDirectories = new Set(
      [...snapshot.records.values()]
        .filter(({ node }) => node.type === "directory" && node.path !== "")
        .map(({ node }) => node.path),
    );
    // A checkpoint can retain empty ancestors whose physical contents are now excluded.
    for (const node of documents[1]?.values() ?? []) {
      if (node.type === "directory") {
        knownDirectories.add(node.path);
      }
    }
    let canonicalPaths: Set<string> | undefined;
    let scanFailure: unknown;
    // Older accepted roots can contain the pnpm fallback store. Try current
    // membership first, then restore only that historical eligibility for repair.
    for (const includeLegacyPnpmStore of [false, true]) {
      let projectionPaths: Set<string> | undefined;
      let projectionDirectories: Set<string> | undefined;
      for (const candidate of [
        "projection",
        "canonical",
        "canonicalWithProjectionPaths",
      ] as const) {
        const extendCanonical = candidate === "canonicalWithProjectionPaths";
        if (extendCanonical && !projectionPaths) {
          continue;
        }
        const root = candidate === "projection" ? row.projection_path : action.canonicalRoot;
        const nodes: LocalWorkspaceManifestNode[] = [];
        try {
          let includePaths: Set<string> | undefined;
          const preserveDirectories = new Set(knownDirectories);
          if (candidate !== "projection") {
            canonicalPaths ??= await selectLocalWorkspaceCanonicalPaths({
              root,
              admittedPaths: row.source_paths_json,
              baselinePaths,
              assertCurrent: () => undefined,
            });
            includePaths = new Set(canonicalPaths);
            // Keep the original canonical candidate first: a later guest addition
            // can share a name with unrelated host-only bytes.
            if (extendCanonical) {
              for (const entryPath of projectionPaths!) {
                includePaths.add(entryPath);
              }
              for (const entryPath of projectionDirectories!) {
                preserveDirectories.add(entryPath);
              }
            }
            for (const document of documents) {
              for (const entryPath of document.keys()) {
                includePaths.add(entryPath);
              }
            }
          }
          await scanActualWorkspaceManifest({
            root,
            baseCommit: row.base_commit,
            includePaths,
            preserveDirectories,
            buildCacheInputs: retained,
            includeLegacyPnpmStore,
            onEntry: (node) => nodes.push(node),
          });
        } catch (error) {
          scanFailure = error;
          continue;
        }
        if (candidate === "projection") {
          // Failed scans never contribute partial hints. Names only select a later
          // candidate; they do not enroll files or change source admission.
          projectionPaths = new Set(nodes.map((node) => node.path));
          projectionDirectories = new Set(
            nodes.filter((node) => node.type === "directory").map((node) => node.path),
          );
        }
        const records = createLocalWorkspaceManifestTree(nodes);
        if (
          checkpoint &&
          records.get("")!.treeRef === checkpoint.treeRoot &&
          expectedRoot === checkpoint.previousTreeRoot
        ) {
          const [base, result] = documents;
          updateLocalWorkspaceManifestTree(
            records,
            [...new Set([...base!.keys(), ...result!.keys()])].map((entryPath) => ({
              path: entryPath,
              node: base!.get(entryPath),
            })),
          );
        }
        const treeRoot = records.get("")!.treeRef;
        const repairedNodes = [...records.values()]
          .map(({ node }) => node)
          .filter((node) => node.path !== "");
        const rebuiltRoot = row.tree_root_digest
          ? treeRoot
          : row.baseline_json
            ? manifestDocument(repairedNodes, row.base_commit, undefined, "stored").manifestRef
            : localWorkspaceManifestRootReference(records, row.base_commit);
        // Reconstruct only the exact saved merge base. Divergent live files remain edits.
        if (rebuiltRoot === expectedRoot) {
          return {
            kind: "replace",
            update: prepareUpdate(
              {
                kind: "update",
                revision: row.revision,
                patch: {
                  tree_root_digest: localWorkspaceDigestBytes(treeRoot),
                  ...(!row.tree_root_digest && !row.pending_ref ? { baseline_json: null } : {}),
                  canonical_fingerprints: null,
                  projection_fingerprints: null,
                },
              },
              prepareLocalWorkspaceTreePacks(records),
            ),
          };
        }
      }
    }
    throw new Error(
      "Local workspace baseline nodes are missing and neither workspace matches the saved baseline or a verified checkpoint. " +
        `Both workspaces were preserved: canonical ${action.canonicalRoot}; sandbox ${row.projection_path}. ` +
        "A Gateway administrator must recover the saved baseline inventory before retrying the session. Inspect the preserved changes with: " +
        `diff -ru -- ${shellEscape(action.canonicalRoot)} ${shellEscape(row.projection_path)}. ` +
        "Do not recreate or delete either workspace; retrying cannot safely choose between divergent edits.",
      { cause: scanFailure },
    );
  }
  if (action.kind === "replace") {
    const manifest = parseWorkerWorkspaceManifest(
      action.rawManifest,
      action.manifestRef,
      action.buildCacheInputs,
    );
    const records = createLocalWorkspaceManifestTree([
      ...manifest.entries,
      ...(manifest.directories ?? []).map((entryPath) => ({
        path: entryPath,
        type: "directory" as const,
      })),
    ]);
    const resultingRoot = localWorkspaceManifestRootReference(records, manifest.baseCommit);
    const mutation: LocalWorkspaceMutation = {
      kind: "update",
      revision: row.revision,
      patch: action.patch,
      manifest: {
        previousRoot: row.baseline_ref,
        resultingRoot,
        records: [],
        removed: [],
        treeRoot: records.get("")!.treeRef,
        previousTreeRoot: row.tree_root_digest
          ? localWorkspaceDigestReference(row.tree_root_digest)
          : null,
        replace: true,
      },
    };
    // Keep the full tree between workers; the host publishes only the accepted root.
    return {
      kind: "replace",
      update: prepareUpdate(mutation, prepareLocalWorkspaceTreePacks(records)),
    };
  }
  if (action.kind === "materialize" && row.baseline_json && row.baseline_ref) {
    // Pending legacy receipts name these exact bytes until acceptance migrates them.
    return { kind: "materialize", rawManifest: row.baseline_json, manifestRef: row.baseline_ref };
  }
  let { records } = snapshot;
  const replacing = action.kind === "prepare" && action.manifest.replace;
  if (replacing) {
    records = new Map(action.manifest.records.map((record) => [record.node.path, record]));
  }
  if (!replacing && !row.tree_root_digest && row.baseline_json && row.baseline_ref) {
    const baseline = parseWorkerWorkspaceManifest(
      row.baseline_json,
      row.baseline_ref,
      undefined,
      "stored",
    );
    records = createLocalWorkspaceManifestTree([
      ...baseline.entries,
      ...(baseline.directories ?? []).map((entryPath) => ({
        path: entryPath,
        type: "directory" as const,
      })),
    ]);
  } else if (records.size === 0) {
    if (row.baseline_ref) {
      throw new Error("Local workspace baseline nodes are missing");
    }
    records = createLocalWorkspaceManifestTree([]);
  }
  if (action.kind === "convert") {
    const nodes = Array.from(records.values(), ({ node }) => node).filter(
      (node) => node.path !== "",
    );
    if (!row.baseline_json) {
      records = createLocalWorkspaceManifestTree(nodes);
    }
    const rebuiltRef = row.baseline_json
      ? manifestDocument(nodes, row.base_commit, undefined, "stored").manifestRef
      : localWorkspaceManifestRootReference(records, row.base_commit);
    if (rebuiltRef !== row.baseline_ref) {
      // Keep the source until the existing full scan and checkpoint replacement settles it.
      return { kind: "rescan" };
    }
    return {
      kind: "replace",
      update: prepareUpdate(
        {
          kind: "update",
          revision: row.revision,
          patch: {
            tree_root_digest: localWorkspaceDigestBytes(records.get("")!.treeRef),
            // A pending legacy receipt owns these exact bytes until its existing settlement finishes.
            baseline_json: row.pending_ref ? row.baseline_json : null,
            baseline_ref: row.baseline_ref,
            source_paths_json: row.source_paths_json,
          },
        },
        prepareLocalWorkspaceTreePacks(records),
      ),
    };
  }
  if (action.kind === "prepare") {
    const manifest = action.manifest;
    if (!manifest.replace) {
      for (const entryPath of manifest.removed) {
        records.delete(entryPath);
      }
      for (const record of manifest.records) {
        records.set(record.node.path, record);
      }
    }
    return {
      kind: "replace",
      update: prepareUpdate(
        {
          kind: "update",
          revision: row.revision,
          patch: action.patch,
          manifest: {
            ...manifest,
            records: [],
            removed: [],
            treeRoot: records.get("")!.treeRef,
            previousTreeRoot: row.tree_root_digest
              ? localWorkspaceDigestReference(row.tree_root_digest)
              : null,
          },
        },
        prepareLocalWorkspaceTreePacks(records),
      ),
    };
  }
  if (action.kind === "materialize") {
    return {
      kind: "materialize",
      ...manifestDocument(
        Array.from(records.values(), ({ node }) => node).filter((node) => node.path !== ""),
        row.base_commit,
        undefined,
        "stored",
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
  const preserveDirectories = new Set<string>();
  for (const [entryPath, { node }] of records) {
    if (entryPath === "") {
      continue;
    }
    if (node.type === "directory") {
      preserveDirectories.add(entryPath);
    }
    if (action.target === "projection") {
      canonicalPaths.add(entryPath);
    }
  }
  const fingerprintTarget = action.target === "canonical" ? "projection" : "canonical";
  const previousFingerprints =
    fingerprintTarget === "canonical" ? row.canonical_fingerprints : row.projection_fingerprints;
  const seen = new Set<string>();
  const changes: LocalWorkspaceManifestChange[] = [];
  const previousTreeRoot = row.tree_root_digest
    ? localWorkspaceDigestReference(row.tree_root_digest)
    : null;
  const scanStartedAtMs = Date.now();
  const fingerprintScan = prepareLocalWorkspaceFingerprints(
    records,
    previousTreeRoot ?? records.get("")!.treeRef,
    previousTreeRoot ? previousFingerprints : null,
    scanStartedAtMs,
  );
  await scanActualWorkspaceManifest({
    root: action.target === "canonical" ? row.projection_path : action.canonicalRoot,
    baseCommit: row.base_commit,
    includePaths: action.target === "projection" ? canonicalPaths : undefined,
    preserveDirectories,
    buildCacheInputs: new Set(retained),
    reuseFile: fingerprintScan.reuseFile,
    onEntry(node, identity) {
      seen.add(node.path);
      const previous = records.get(node.path);
      if (!sameEntry(previous?.node, node)) {
        changes.push({ path: node.path, node });
      }
      if (identity !== undefined) {
        fingerprintScan.observe(node.path, identity);
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
  const delta = updateLocalWorkspaceManifestTree(records, changes);
  const currentNodes: LocalWorkspaceManifestNode[] = [];
  for (const entryPath of inspected) {
    const current = records.get(entryPath);
    if (current) {
      currentNodes.push(current.node);
    }
  }
  const base = manifestDocument(previousNodes, row.base_commit, retained, "stored");
  const current = manifestDocument(currentNodes, row.base_commit, retained);
  const replace = row.tree_root_digest === null;
  const treeRoot = records.get("")!.treeRef;
  const resultingRoot = localWorkspaceManifestRootReference(records, row.base_commit);
  const blob = fingerprintScan.encode(records, treeRoot);
  const changedFingerprint =
    blob !== null &&
    blob !== previousFingerprints &&
    (!previousFingerprints || !blob.equals(previousFingerprints));
  const fingerprints: LocalWorkspaceManifestScan["fingerprints"] =
    blob && changedFingerprint
      ? { target: fingerprintTarget, blob: blob.toString("base64") }
      : undefined;
  const admitted = retained.length ? parseLocalWorkspaceSourcePaths(row.source_paths_json) : [];
  const known = new Set(admitted);
  const added = retained.filter((entryPath) => !known.has(entryPath));
  const unchanged = resultingRoot === row.baseline_ref;
  const observation =
    added.length || (unchanged && changedFingerprint)
      ? prepareUpdate({
          kind: "update",
          revision: row.revision,
          patch: {
            ...(added.length ? { source_paths_json: JSON.stringify([...admitted, ...added]) } : {}),
            ...(unchanged && changedFingerprint
              ? {
                  [fingerprintTarget === "canonical"
                    ? "canonical_fingerprints"
                    : "projection_fingerprints"]: blob,
                }
              : {}),
          },
        })
      : undefined;
  return {
    version: 1,
    kind: "scan",
    previousRoot: row.baseline_ref,
    resultingRoot,
    treeRoot,
    previousTreeRoot,
    ...(fingerprints ? { fingerprints } : {}),
    preparations:
      treeRoot === previousTreeRoot
        ? []
        : prepareLocalWorkspaceTreePacks(
            records,
            replace ? undefined : [...delta.records.map(({ node }) => node.path), ...delta.removed],
          ),
    records: [],
    observation,
    removed: [],
    ...(replace ? { replace: true } : {}),
    baseManifestRaw: base.rawManifest,
    baseManifestRef: base.manifestRef,
    currentManifestRaw: current.rawManifest,
    currentManifestRef: current.manifestRef,
    buildCacheInputs: retained,
  };
}
