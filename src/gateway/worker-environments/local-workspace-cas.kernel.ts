import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import {
  decodeLocalWorkspaceSourcePathSet,
  localWorkspaceDigestBytes,
  localWorkspaceDigestReference,
  LOCAL_WORKSPACE_CONTENT_BATCH,
  type LocalWorkspacePreparation,
} from "./local-workspace-cas.js";
import type { LocalWorkspaceManifestRecord } from "./local-workspace-manifest-tree.js";
import type { LocalWorkspaceManifestMutation } from "./local-workspace-store.types.js";

const packs = "local_workspace_tree_packs";
const pathSets = "local_workspace_source_path_sets";
const epochKey = "workspace.manifest.sweepEpoch";
const query = (db: EngineConnection) => getNodeSqliteKysely<DB>(db);

export function currentLocalWorkspaceSweepEpoch(db: EngineConnection): number {
  if (!tableExists(db, "config_machine_state")) {
    return 0;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", epochKey),
  );
  return row ? Number(row.value_json) : 0;
}

/** One bounded worker transaction. Preparation does not change any projection authority. */
export function prepareLocalWorkspaceContentInDatabase(
  db: EngineConnection,
  preparation: LocalWorkspacePreparation,
): number {
  if (!tableExists(db, packs)) {
    // sqlite-allow-raw -- Canonical first-use schema admission for the existing workspace feature.
    db.exec(getOpenClawStateFeatureSchemaSql("local_workspace_projections"));
  }
  const epoch = currentLocalWorkspaceSweepEpoch(db);
  if (preparation.packs?.length) {
    if (preparation.packs.length > LOCAL_WORKSPACE_CONTENT_BATCH) {
      throw new Error("Local workspace pack preparation exceeds its batch limit");
    }
    const rows = preparation.packs.map((record) => ({
      tree_digest: localWorkspaceDigestBytes(record.treeRef),
      records_json: JSON.stringify(record.records),
      children_json: JSON.stringify(record.children),
      sweep_epoch: epoch,
    }));
    const existing = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom(packs)
        .select(["tree_digest", "sweep_epoch"])
        .where(
          "tree_digest",
          "in",
          rows.map((row) => row.tree_digest),
        ),
    ).rows;
    const known = new Set(existing.map((row) => localWorkspaceDigestReference(row.tree_digest)));
    const missing = rows.filter(
      (row) => !known.has(localWorkspaceDigestReference(row.tree_digest)),
    );
    if (missing.length) {
      executeSqliteQuerySync(
        db,
        query(db)
          .insertInto(packs)
          .values(missing)
          .onConflict((conflict) =>
            conflict.column("tree_digest").doUpdateSet((eb) => ({
              sweep_epoch: eb
                .case()
                .when(`${packs}.sweep_epoch`, "<", epoch)
                .then(epoch)
                .else(eb.ref(`${packs}.sweep_epoch`))
                .end(),
            })),
          ),
      );
    }
    const reused = existing.filter((row) => row.sweep_epoch < epoch).map((row) => row.tree_digest);
    if (reused.length) {
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable(packs)
          .set({ sweep_epoch: epoch })
          .where("tree_digest", "in", reused)
          .where("sweep_epoch", "<", epoch),
      );
    }
  }
  if (preparation.paths) {
    const digest = localWorkspaceDigestBytes(preparation.paths.digest);
    executeSqliteQuerySync(
      db,
      query(db)
        .insertInto(pathSets)
        .values({
          path_digest: digest,
          paths_zstd: Buffer.from(preparation.paths.compressed),
          sweep_epoch: epoch,
        })
        .onConflict((conflict) =>
          conflict.column("path_digest").doUpdateSet((eb) => ({
            sweep_epoch: eb
              .case()
              .when(`${pathSets}.sweep_epoch`, "<", epoch)
              .then(epoch)
              .else(eb.ref(`${pathSets}.sweep_epoch`))
              .end(),
          })),
        ),
    );
  }
  return epoch;
}

export function readLocalWorkspaceSourcePaths(db: EngineConnection, digest: Uint8Array): string {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom(pathSets)
      .select("paths_zstd")
      .where("path_digest", "=", Buffer.from(digest)),
  );
  if (!row) {
    throw new Error("Local workspace source path set is missing");
  }
  return decodeLocalWorkspaceSourcePathSet(row.paths_zstd);
}

/** Fetch directory packs level by level inside the caller's read snapshot. */
export function readLocalWorkspaceTree(db: EngineConnection, root: Uint8Array) {
  const records = new Map<string, LocalWorkspaceManifestRecord>();
  let pending = [localWorkspaceDigestReference(root)];
  while (pending.length) {
    const next: string[] = [];
    // Stay below both engines' parameter limits even for exceptionally wide trees.
    for (let offset = 0; offset < pending.length; offset += 8192) {
      const batch = pending.slice(offset, offset + 8192);
      const rows = executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom(packs)
          .select(["records_json", "children_json"])
          .where("tree_digest", "in", batch.map(localWorkspaceDigestBytes)),
      ).rows;
      if (rows.length !== batch.length) {
        throw new Error("Local workspace baseline nodes are missing");
      }
      for (const row of rows) {
        // SAFETY: Immutable packs and their links are produced together by the tree owner.
        const entries = JSON.parse(row.records_json) as LocalWorkspaceManifestRecord[];
        for (const record of entries) {
          records.set(record.node.path, record);
        }
        // SAFETY: This is the owner-produced child-pack digest array.
        for (const child of JSON.parse(row.children_json) as string[]) {
          next.push(child);
        }
      }
    }
    pending = next;
  }
  // Sibling links are internal to an owner-produced pack; absent child packs fail the batch check.
  return records;
}

export function beginLocalWorkspaceSweepInDatabase(db: EngineConnection): number {
  const epoch = currentLocalWorkspaceSweepEpoch(db) + 1;
  executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("config_machine_state")
      .values({
        state_key: epochKey,
        value_json: String(epoch),
        updated_at_ms: Date.now(),
      })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet({
          value_json: String(epoch),
          updated_at_ms: Date.now(),
        }),
      ),
  );
  return epoch;
}

export type LocalWorkspaceSweepCandidates = { packs: Uint8Array[]; paths: Uint8Array[] };

/** Select unreachable old content in the existing read worker's snapshot. */
export function readLocalWorkspaceSweepCandidates(
  db: EngineConnection,
  epoch: number,
): LocalWorkspaceSweepCandidates {
  const result: LocalWorkspaceSweepCandidates = { packs: [], paths: [] };
  if (!tableExists(db, packs)) {
    return result;
  }
  const reachable = new Set<string>();
  const paths = new Set<string>();
  const roots = new Set<string>();
  for (const row of executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("local_workspace_projections")
      .select(["tree_root_digest", "source_paths_digest", "checkpoint_json"]),
  ).rows) {
    if (row.tree_root_digest) {
      roots.add(localWorkspaceDigestReference(row.tree_root_digest));
    }
    if (row.source_paths_digest) {
      paths.add(localWorkspaceDigestReference(row.source_paths_digest));
    }
    if (row.checkpoint_json) {
      // SAFETY: The projection owner writes this recovery document with its pending receipt.
      const checkpoint = JSON.parse(row.checkpoint_json) as LocalWorkspaceManifestMutation;
      if (checkpoint.treeRoot) {
        roots.add(checkpoint.treeRoot);
      }
      if (checkpoint.previousTreeRoot) {
        roots.add(checkpoint.previousTreeRoot);
      }
    }
  }
  // Traverse the union once: revisions and projections share most of their graph.
  // GC reads only child-pack arrays, never record payloads or decoded manifest maps.
  const pending = new Set(roots);
  while (pending.size) {
    const batch = [...pending].slice(0, LOCAL_WORKSPACE_CONTENT_BATCH);
    const rows = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom(packs)
        .select(["tree_digest", "children_json"])
        .where("tree_digest", "in", batch.map(localWorkspaceDigestBytes)),
    ).rows;
    if (rows.length !== batch.length) {
      throw new Error("Local workspace baseline nodes are missing");
    }
    for (const row of rows) {
      const ref = localWorkspaceDigestReference(row.tree_digest);
      reachable.add(ref);
      pending.delete(ref);
      // SAFETY: The pack owner records immutable child digests beside its payload.
      for (const childRef of JSON.parse(row.children_json) as string[]) {
        if (!reachable.has(childRef)) {
          pending.add(childRef);
        }
      }
    }
  }
  for (const row of executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(packs)
      .select("tree_digest")
      .where("sweep_epoch", "<", epoch - 1),
  ).rows) {
    if (!reachable.has(localWorkspaceDigestReference(row.tree_digest))) {
      result.packs.push(row.tree_digest);
    }
  }
  for (const row of executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(pathSets)
      .select("path_digest")
      .where("sweep_epoch", "<", epoch - 1),
  ).rows) {
    if (!paths.has(localWorkspaceDigestReference(row.path_digest))) {
      result.paths.push(row.path_digest);
    }
  }
  return result;
}

/** The epoch predicate protects content reused after the read snapshot. */
export function deleteLocalWorkspaceSweepBatchInDatabase(
  db: EngineConnection,
  epoch: number,
  batch: LocalWorkspaceSweepCandidates,
): void {
  if (
    batch.packs.length > LOCAL_WORKSPACE_CONTENT_BATCH ||
    batch.paths.length > LOCAL_WORKSPACE_CONTENT_BATCH
  ) {
    throw new Error("Local workspace sweep exceeds its batch limit");
  }
  if (batch.packs.length) {
    executeSqliteQuerySync(
      db,
      query(db)
        .deleteFrom(packs)
        .where(
          "tree_digest",
          "in",
          batch.packs.map((value) => Buffer.from(value)),
        )
        .where("sweep_epoch", "<", epoch - 1),
    );
  }
  if (batch.paths.length) {
    executeSqliteQuerySync(
      db,
      query(db)
        .deleteFrom(pathSets)
        .where(
          "path_digest",
          "in",
          batch.paths.map((value) => Buffer.from(value)),
        )
        .where("sweep_epoch", "<", epoch - 1),
    );
  }
}

export function pruneLocalWorkspaceLegacyBatchInDatabase(
  db: EngineConnection,
  id: string,
): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("local_workspace_projections")
      .select("tree_root_digest")
      .where("worktree_id", "=", id),
  );
  if (!row?.tree_root_digest) {
    return false;
  }
  const batch = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("local_workspace_manifest_nodes")
      .select("path")
      .where("worktree_id", "=", id)
      .limit(LOCAL_WORKSPACE_CONTENT_BATCH),
  ).rows;
  if (!batch.length) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("local_workspace_manifest_nodes")
      .where("worktree_id", "=", id)
      .where(
        "path",
        "in",
        batch.map((entry) => entry.path),
      ),
  );
  return batch.length === LOCAL_WORKSPACE_CONTENT_BATCH;
}
