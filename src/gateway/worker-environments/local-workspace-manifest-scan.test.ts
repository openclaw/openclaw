import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { inflateRawSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import {
  localWorkspaceDigestBytes,
  prepareLocalWorkspaceTreePacks,
  type LocalWorkspacePreparation,
} from "./local-workspace-cas.js";
import {
  beginLocalWorkspaceSweepInDatabase,
  deleteLocalWorkspaceSweepBatchInDatabase,
  prepareLocalWorkspaceContentInDatabase,
  readLocalWorkspaceSweepCandidates,
  readLocalWorkspaceTree,
} from "./local-workspace-cas.kernel.js";
import {
  executeLocalWorkspaceManifestRead,
  readLocalWorkspaceManifestRows,
} from "./local-workspace-manifest-scan.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
} from "./local-workspace-manifest-tree.js";
import { mutateLocalWorkspaceProjection } from "./local-workspace-store.kernel.js";
import { localWorkspaceProjectionFixture } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceMutation } from "./local-workspace-store.types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

it.each(["edit", "delete one-child root", "delete two-sided root"])(
  "keeps a complete incremental pack graph through acceptance and GC after %s",
  async (operation) => {
    using db = new DatabaseSync(":memory:");
    const root = await fs.realpath(dirs.make("workspace-incremental-scan-"));
    const files = Array.from(
      { length: operation === "delete one-child root" ? 2 : 64 },
      (_, index) => ({
        path: `edited/deep/file-${String(index).padStart(4, "0")}.txt`,
        type: "file" as const,
        mode: 0o644,
        size: 3,
        sha256: hash("old"),
      }),
    );
    const directories = ["edited", "edited/deep", "untouched"];
    const nodes = [
      ...directories.map((entryPath) => ({ path: entryPath, type: "directory" as const })),
      ...files,
      ...["a", "b"].map((name) => ({
        path: `untouched/${name}.txt`,
        type: "file" as const,
        mode: 0o644,
        size: 3,
        sha256: hash("old"),
      })),
    ];
    await Promise.all(
      directories.map((entryPath) => fs.mkdir(path.join(root, entryPath), { recursive: true })),
    );
    await Promise.all(
      nodes
        .filter((node) => node.type === "file")
        .map((node) => fs.writeFile(path.join(root, node.path), "old")),
    );
    await requireGit(root, ["init", "--quiet"]);
    await requireGit(root, ["add", "."]);
    const baseline = createLocalWorkspaceManifestTree(nodes);
    const treeRoot = localWorkspaceDigestBytes(baseline.get("")!.treeRef);
    const row = {
      ...localWorkspaceProjectionFixture("incremental", root),
      tree_root_digest: treeRoot,
      baseline_ref: localWorkspaceManifestRootReference(baseline, "a".repeat(40)),
    };
    mutateLocalWorkspaceProjection(db, row.worktree_id, { kind: "create", row });
    const prepare = (batches: readonly Uint8Array[]) => {
      for (const batch of batches) {
        const preparation = deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation;
        prepareLocalWorkspaceContentInDatabase(db, preparation);
      }
    };
    prepare(prepareLocalWorkspaceTreePacks(baseline));
    const directoryRoot = baseline.get(baseline.get("edited/deep")!.children!)!;
    const changedPath = operation === "edit" ? files[32]!.path : directoryRoot.node.path;
    if (operation === "edit") {
      await fs.writeFile(path.join(root, changedPath), "new");
    } else {
      expect(
        [directoryRoot.left, directoryRoot.right].filter((child) => child !== null),
      ).toHaveLength(operation === "delete one-child root" ? 1 : 2);
      await fs.unlink(path.join(root, changedPath));
    }
    const expected = createLocalWorkspaceManifestTree(
      nodes.flatMap((node) =>
        node.path !== changedPath
          ? [node]
          : operation === "edit"
            ? [{ ...files[32]!, sha256: hash("new") }]
            : [],
      ),
    );
    const promoted = expected.get(expected.get("edited/deep")!.children!)!;
    // Initial publication must not accidentally supply the pack needed after deletion.
    expect(
      db
        .prepare("SELECT 1 FROM local_workspace_tree_packs WHERE tree_digest = ?")
        .get(localWorkspaceDigestBytes(promoted.treeRef)),
    ).toBeUndefined();
    const input = {
      id: row.worktree_id,
      revision: 0,
      action: { kind: "scan" as const, target: "projection" as const, canonicalRoot: root },
    };
    const result = await executeLocalWorkspaceManifestRead(
      readLocalWorkspaceManifestRows(db, input),
      input.action,
    );
    if (result.kind !== "scan") {
      throw new Error("Missing incremental scan");
    }
    const counter = trackSqliteStatementExecutions(db, ["preparationReads"], (sql) =>
      /^select\b.*"sweep_epoch".*"local_workspace_tree_packs"/i.test(sql)
        ? "preparationReads"
        : null,
    );
    try {
      prepare(result.preparations!);
      expect(counter.counts.preparationReads).toBe(1);
    } finally {
      counter.restore();
    }
    const nextRoot = localWorkspaceDigestBytes(result.treeRoot!);
    const { preparations: _preparations, observation: _observation, ...checkpoint } = result;
    let revision = 0;
    if (operation === "edit") {
      mutateLocalWorkspaceProjection(db, row.worktree_id, {
        kind: "update",
        revision: 0,
        patch: { checkpoint_json: JSON.stringify(checkpoint) },
      });
      db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state"));
      beginLocalWorkspaceSweepInDatabase(db);
      const pendingEpoch = beginLocalWorkspaceSweepInDatabase(db);
      expect(readLocalWorkspaceSweepCandidates(db, pendingEpoch).packs).toEqual([]);
      expect(readLocalWorkspaceTree(db, treeRoot)).toEqual(baseline);
      expect(readLocalWorkspaceTree(db, nextRoot)).toEqual(expected);
      revision = 1;
    }
    mutateLocalWorkspaceProjection(db, row.worktree_id, {
      kind: "update",
      revision,
      patch: { checkpoint_json: null },
      manifest: checkpoint,
    });
    expect(
      readLocalWorkspaceManifestRows(db, { ...input, revision: revision + 1 }).records,
    ).toEqual(expected);
    expect(result.preparations).toHaveLength(1);
    const packs = result.preparations!.flatMap(
      (batch) => (deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation).packs!,
    );
    // The three path components select three directory packs plus the sentinel root pack.
    expect(packs).toHaveLength(4);
    expect(result.resultingRoot).toBe(
      localWorkspaceManifestRootReference(expected, row.base_commit),
    );
    if (operation !== "edit") {
      db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state"));
      beginLocalWorkspaceSweepInDatabase(db);
      beginLocalWorkspaceSweepInDatabase(db);
    }
    const acceptedEpoch = beginLocalWorkspaceSweepInDatabase(db);
    const garbage = readLocalWorkspaceSweepCandidates(db, acceptedEpoch);
    expect(garbage.packs.length).toBeGreaterThan(0);
    deleteLocalWorkspaceSweepBatchInDatabase(db, acceptedEpoch, garbage);
    expect(readLocalWorkspaceTree(db, nextRoot)).toEqual(expected);
  },
);

async function repairFixture(historicalCache = false) {
  const root = await fs.realpath(dirs.make("workspace-baseline-repair-"));
  const projection = path.join(root, "projection");
  const canonical = path.join(root, "canonical");
  for (const directory of [projection, canonical]) {
    await fs.mkdir(path.join(directory, "nested"), { recursive: true });
    await fs.writeFile(path.join(directory, "nested/file.txt"), "baseline");
    if (historicalCache) {
      await fs.mkdir(path.join(directory, ".openclaw/.pnpm-store"), { recursive: true });
      await fs.writeFile(path.join(directory, ".openclaw/.pnpm-store/cache"), "baseline");
      await fs.mkdir(path.join(directory, "node_modules"));
      await fs.writeFile(path.join(directory, "node_modules/installed.js"), "local dependency");
    }
  }
  await requireGit(canonical, ["init", "--quiet"]);
  await requireGit(canonical, ["add", "nested/file.txt"]);
  const records = createLocalWorkspaceManifestTree([
    { path: "nested", type: "directory" },
    { path: "nested/file.txt", type: "file", mode: 0o644, size: 8, sha256: hash("baseline") },
    ...(historicalCache
      ? [
          { path: ".openclaw", type: "directory" as const },
          { path: ".openclaw/.pnpm-store", type: "directory" as const },
          {
            path: ".openclaw/.pnpm-store/cache",
            type: "file" as const,
            mode: 0o644,
            size: 8,
            sha256: hash("baseline"),
          },
        ]
      : []),
  ]);
  const treeRoot = localWorkspaceDigestBytes(records.get("")!.treeRef);
  const snapshot = {
    row: {
      revision: 7,
      projection_path: projection,
      base_commit: "a".repeat(40),
      source_paths_json: '["nested/file.txt"]',
      baseline_json: null,
      baseline_ref: localWorkspaceManifestRootReference(records, "a".repeat(40)),
      tree_root_digest: treeRoot,
      source_paths_digest: null,
      canonical_fingerprints: null,
      projection_fingerprints: null,
      pending_ref: "refs/openclaw/results/preserved",
      checkpoint_json: null as string | null,
    },
    records: new Map(),
  };
  return { projection, canonical, snapshot, treeRoot, records };
}

it.each([
  ["projection", false],
  ["canonical", false],
  ["checkpoint", false],
  ["projection", true],
  ["checkpoint", true],
] as const)(
  "reconstructs a collected baseline from the verified %s filesystem (historical cache: %s)",
  async (matching, historicalCache) => {
    const { projection, canonical, snapshot, treeRoot, records } =
      await repairFixture(historicalCache);
    if (matching === "checkpoint") {
      await fs.writeFile(path.join(canonical, "nested/file.txt"), "pending edit");
      const scan = await executeLocalWorkspaceManifestRead(
        { ...snapshot, records },
        {
          kind: "scan",
          target: "projection",
          canonicalRoot: canonical,
        },
      );
      snapshot.row.checkpoint_json = JSON.stringify(scan);
    }
    if (matching === "canonical") {
      // A later guest name must not enroll unrelated canonical bytes or spoil
      // an already matching canonical candidate.
      await fs.writeFile(path.join(projection, "unaccepted.txt"), "guest addition");
      await fs.writeFile(path.join(canonical, "unaccepted.txt"), "host-only bytes");
    }
    const divergent = matching === "projection" ? canonical : projection;
    await fs.writeFile(path.join(divergent, "nested/file.txt"), "preserved live edit");
    const result = await executeLocalWorkspaceManifestRead(snapshot, {
      kind: "repair",
      canonicalRoot: canonical,
    });
    expect(result.kind).toBe("replace");
    if (result.kind !== "replace") {
      throw new Error("Missing prepared repair");
    }
    const mutation = deserialize(inflateRawSync(result.update.mutation)) as LocalWorkspaceMutation;
    expect(mutation).toEqual({
      kind: "update",
      revision: 7,
      patch: {
        tree_root_digest: treeRoot,
        canonical_fingerprints: null,
        projection_fingerprints: null,
      },
    });
    const nodes = result.update.preparations!.flatMap((batch) => {
      const preparation = deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation;
      return preparation.packs!.flatMap((pack) => pack.records);
    });
    expect(nodes.find(({ node }) => node.path === "nested/file.txt")!.node).toMatchObject({
      sha256: hash("baseline"),
      size: 8,
    });
    expect(nodes.find(({ node }) => node.path === "")!.treeRef).toBe(
      `sha256:${Buffer.from(treeRoot).toString("hex")}`,
    );
    expect(await fs.readFile(path.join(divergent, "nested/file.txt"), "utf8")).toBe(
      "preserved live edit",
    );
  },
);

it.each(["different", "identical"] as const)(
  "preserves %s later edits when neither filesystem matches the exact missing baseline",
  async (edits) => {
    const { projection, canonical, snapshot } = await repairFixture(true);
    await fs.writeFile(path.join(projection, "nested/file.txt"), "guest edit");
    const hostEdit = edits === "identical" ? "guest edit" : "host edit";
    await fs.writeFile(path.join(canonical, "nested/file.txt"), hostEdit);
    await expect(
      executeLocalWorkspaceManifestRead(snapshot, {
        kind: "repair",
        canonicalRoot: canonical,
      }),
    ).rejects.toThrow("neither workspace matches the saved baseline");
    expect(await fs.readFile(path.join(projection, "nested/file.txt"), "utf8")).toBe("guest edit");
    expect(await fs.readFile(path.join(canonical, "nested/file.txt"), "utf8")).toBe(hostEdit);
  },
);
