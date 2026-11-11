import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import { inflateRawSync } from "node:zlib";
import { afterEach, assert, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import {
  decodeLocalWorkspaceTree,
  localWorkspaceDigestBytes,
  prepareLocalWorkspaceSourcePathSet,
  prepareLocalWorkspaceTreePacks,
  type LocalWorkspacePreparation,
} from "./local-workspace-cas.js";
import {
  beginLocalWorkspaceSweepInDatabase,
  deleteLocalWorkspaceSweepBatchInDatabase,
  prepareLocalWorkspaceContentInDatabase,
  readLocalWorkspaceSourcePaths,
  readLocalWorkspaceSweepCandidates,
  readLocalWorkspaceTree,
} from "./local-workspace-cas.kernel.js";
import { prepareLocalWorkspaceFingerprints } from "./local-workspace-fingerprints.js";
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
import { withWorkspaceHashMemo } from "./workspace-hash-memo.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function tree(character: string) {
  return createLocalWorkspaceManifestTree([
    { path: "entry.txt", type: "file", mode: 0o644, size: 1, sha256: character.repeat(64) },
  ]);
}

function prepareTreePacks(
  db: DatabaseSync,
  records: Parameters<typeof prepareLocalWorkspaceTreePacks>[0],
  paths?: LocalWorkspacePreparation["paths"],
) {
  for (const [index, batch] of prepareLocalWorkspaceTreePacks(records).entries()) {
    const preparation = deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation;
    prepareLocalWorkspaceContentInDatabase(
      db,
      index === 0 && paths ? { ...preparation, paths } : preparation,
    );
  }
}

it("materializes a manifest snapshot after its database closes", async () => {
  const database = new DatabaseSync(":memory:");
  const worktreeId = randomUUID();
  const records = createLocalWorkspaceManifestTree([
    { path: "entry.txt", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) },
  ]);
  const action = { kind: "materialize" as const };
  const snapshot = (() => {
    try {
      mutateLocalWorkspaceProjection(database, worktreeId, {
        kind: "create",
        row: {
          ...localWorkspaceProjectionFixture(worktreeId, "/synthetic"),
          canonical_fingerprints: Buffer.alloc(1024, 1),
          projection_fingerprints: Buffer.alloc(2048, 2),
        },
      });
      prepareTreePacks(database, records);
      mutateLocalWorkspaceProjection(database, worktreeId, {
        kind: "update",
        revision: 0,
        patch: {},
        manifest: {
          treeRoot: records.get("")!.treeRef,
          previousRoot: null,
          resultingRoot: localWorkspaceManifestRootReference(records, "a".repeat(40)),
          records: [...records.values()],
          removed: [],
          replace: true,
        },
      });
      using parsing = vi.spyOn(JSON, "parse");
      const reads = trackSqliteStatementExecutions(database, ["projection"], (sql) =>
        /^select\b/i.test(sql) && sql.includes('from "local_workspace_projections"')
          ? "projection"
          : null,
      );
      const captured = readLocalWorkspaceManifestRows(database, {
        id: worktreeId,
        revision: 1,
        action,
      });
      reads.restore();
      // Only the tree digest is needed; materialization never consumes either fingerprint.
      expect(reads.blobBytes.projection).toBe(32);
      expect(parsing.mock.calls.filter(([text]) => text.includes('"node":'))).toHaveLength(0);
      return deserialize(serialize(captured)) as typeof captured;
    } finally {
      database.close();
    }
  })();
  // The read scope is closed: materialization must own all facts, not a live SQLite cursor.
  const value = await executeLocalWorkspaceManifestRead(snapshot, action);
  const expected = JSON.stringify({
    version: 1,
    baseCommit: "a".repeat(40),
    entries: [{ path: "entry.txt", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) }],
  });
  expect(value).toEqual({
    kind: "materialize",
    rawManifest: expected,
    manifestRef: `sha256:${createHash("sha256").update(expected).digest("hex")}`,
  });
});

it.each(["canonical", "projection"] as const)(
  "reads only the opposite fingerprint and preserves hash reuse when scanning toward %s",
  async (target) => {
    using database = new DatabaseSync(":memory:");
    const root = await fs.realpath(dirs.make("workspace-manifest-fingerprint-"));
    const canonicalRoot = path.join(root, "canonical");
    const projectionRoot = path.join(root, "projection");
    const records = createLocalWorkspaceManifestTree([
      {
        path: "entry.txt",
        type: "file",
        mode: 0o644,
        size: 1,
        sha256: createHash("sha256").update("a").digest("hex"),
      },
    ]);
    const treeRoot = records.get("")!.treeRef;
    const fingerprints: Buffer[] = [];
    for (const directory of [canonicalRoot, projectionRoot]) {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "entry.txt"), "a");
      const stats = await fs.lstat(path.join(directory, "entry.txt"), { bigint: true });
      const scan = prepareLocalWorkspaceFingerprints(records, treeRoot, null, Date.now() + 3000);
      scan.observe(
        "entry.txt",
        `gateway:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
      );
      fingerprints.push(scan.encode(records, treeRoot)!);
    }
    await requireGit(canonicalRoot, ["init", "--quiet"]);
    await requireGit(canonicalRoot, ["add", "entry.txt"]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3000);
    const row = {
      ...localWorkspaceProjectionFixture("fingerprints", projectionRoot),
      projection_path: projectionRoot,
      tree_root_digest: localWorkspaceDigestBytes(treeRoot),
      baseline_ref: localWorkspaceManifestRootReference(records, "a".repeat(40)),
      canonical_fingerprints: fingerprints[0]!,
      projection_fingerprints: fingerprints[1]!,
    };
    mutateLocalWorkspaceProjection(database, row.worktree_id, { kind: "create", row });
    prepareTreePacks(database, records);
    const required = target === "canonical" ? fingerprints[1]! : fingerprints[0]!;
    for (const kind of ["scan", "probe"] as const) {
      const action = { kind, target, canonicalRoot };
      const reads = trackSqliteStatementExecutions(database, ["projection"], (sql) =>
        /^select\b/i.test(sql) && sql.includes('from "local_workspace_projections"')
          ? "projection"
          : null,
      );
      const captured = readLocalWorkspaceManifestRows(database, {
        id: row.worktree_id,
        revision: 0,
        action,
        knownTreeRoot: treeRoot,
      });
      reads.restore();
      expect(reads.blobBytes.projection).toBe(32 + required.byteLength);
      expect(captured.records).toBeUndefined();
      const metrics = { contentHashCount: 0, memoHitCount: 0 };
      const value = await withWorkspaceHashMemo(
        new Map(),
        () => executeLocalWorkspaceManifestRead(captured, action, new Map(records)),
        metrics,
      );
      expect(value).toMatchObject({ kind: "scan", resultingRoot: row.baseline_ref });
      expect(metrics.contentHashCount).toBe(0);
    }
    const archived = readLocalWorkspaceManifestRows(database, {
      id: row.worktree_id,
      revision: 0,
      action: {
        kind: "archive",
        canonicalRoot,
        archiveRoot: canonicalRoot,
        snapshotCommit: "a".repeat(40),
      },
      knownTreeRoot: treeRoot,
    });
    expect(archived.row.canonical_fingerprints).toBeNull();
    expect(Buffer.from(archived.row.projection_fingerprints!)).toEqual(fingerprints[1]);
  },
);

it.each([
  ["empty", ""],
  [
    "comma-separated",
    '{"node":{"path":"first","type":"directory"}},{"node":{"path":"second","type":"directory"}}',
  ],
])("rejects %s legacy record JSON after capturing the manifest", async (_label, nodeJson) => {
  using database = new DatabaseSync(":memory:");
  const worktreeId = randomUUID();
  mutateLocalWorkspaceProjection(database, worktreeId, {
    kind: "create",
    row: localWorkspaceProjectionFixture(worktreeId, "/synthetic"),
  });
  database
    .prepare(
      "INSERT INTO local_workspace_manifest_nodes (worktree_id, path, node_json) VALUES (?, ?, ?)",
    )
    .run(worktreeId, "first", nodeJson);
  const action = { kind: "materialize" as const };
  const snapshot = readLocalWorkspaceManifestRows(database, {
    id: worktreeId,
    revision: 0,
    action,
  });
  await expect(executeLocalWorkspaceManifestRead(snapshot, action)).rejects.toThrow(SyntaxError);
});

it.each([2, 64])("loads %i directories with reads bounded by tree depth", (count) => {
  using cleanup = new DisposableStack();
  using db = new DatabaseSync(":memory:");
  const records = createLocalWorkspaceManifestTree(
    Array.from({ length: count }, (_, index) => [
      { path: `dir-${index}`, type: "directory" as const },
      ...["first", "second"].map((name) => ({
        path: `dir-${index}/${name}.txt`,
        type: "file" as const,
        mode: 0o644,
        size: 1,
        sha256: "a".repeat(64),
      })),
    ]).flat(),
  );
  prepareTreePacks(db, records);
  // One sentinel/root pack, one root-directory pack, and one per child directory.
  expect(db.prepare("SELECT count(*) AS n FROM local_workspace_tree_packs").get()!.n).toBe(
    count + 2,
  );
  const counter = trackSqliteStatementExecutions(db, ["reads"], (sql) =>
    /^(?:select|with)\b/i.test(sql) ? "reads" : null,
  );
  cleanup.defer(counter.restore);
  const root = localWorkspaceDigestBytes(records.get("")!.treeRef);
  expect(decodeLocalWorkspaceTree(readLocalWorkspaceTree(db, root))).toEqual(records);
  // Width changes the number of packs, never the number of levels fetched.
  expect(counter.counts.reads).toBeLessThanOrEqual(3);
  counter.restore();
  const childRoot = records.get(records.get("dir-0")!.children!)!;
  db.prepare("DELETE FROM local_workspace_tree_packs WHERE tree_digest = ?").run(
    localWorkspaceDigestBytes(childRoot.treeRef),
  );
  expect(() => readLocalWorkspaceTree(db, root)).toThrow("baseline nodes are missing");
  const surviving = decodeLocalWorkspaceTree(
    readLocalWorkspaceTree(db, root, { allowMissing: true }),
  );
  expect(surviving.has("dir-0")).toBe(true);
  expect(surviving.has("dir-0/first.txt")).toBe(false);
  expect(surviving.has("dir-1/first.txt")).toBe(true);
  db.prepare("UPDATE local_workspace_tree_packs SET records_json = ? WHERE tree_digest = ?").run(
    "{",
    root,
  );
  expect(() =>
    decodeLocalWorkspaceTree(readLocalWorkspaceTree(db, root, { allowMissing: true })),
  ).toThrow(SyntaxError);
});

it("shares an unchanged subdirectory pack across different projection roots", () => {
  using db = new DatabaseSync(":memory:");
  const inventory = (character: string) =>
    createLocalWorkspaceManifestTree([
      { path: "shared", type: "directory" },
      { path: "shared/a.txt", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) },
      { path: "shared/b.txt", type: "file", mode: 0o644, size: 1, sha256: "b".repeat(64) },
      { path: "changed.txt", type: "file", mode: 0o644, size: 1, sha256: character.repeat(64) },
    ]);
  const first = inventory("c");
  const second = inventory("d");
  for (const [index, records] of [first, second].entries()) {
    const id = `sharing-${index}`;
    mutateLocalWorkspaceProjection(db, id, {
      kind: "create",
      row: localWorkspaceProjectionFixture(id, `/synthetic/${id}`),
    });
    prepareTreePacks(db, records);
    mutateLocalWorkspaceProjection(db, id, {
      kind: "update",
      revision: 0,
      patch: { tree_root_digest: localWorkspaceDigestBytes(records.get("")!.treeRef) },
    });
  }
  // Three packs per tree; only the sentinel and root-directory packs differ.
  expect(db.prepare("SELECT count(*) AS n FROM local_workspace_tree_packs").get()!.n).toBe(5);
  const shared = first.get(first.get("shared")!.children!)!.treeRef;
  expect(second.get(second.get("shared")!.children!)!.treeRef).toBe(shared);
  const packed = db
    .prepare("SELECT records_json FROM local_workspace_tree_packs WHERE tree_digest = ?")
    .get(localWorkspaceDigestBytes(shared));
  expect(JSON.parse(String(packed!.records_json))).toHaveLength(2);
  for (const [index, records] of [first, second].entries()) {
    const loaded = readLocalWorkspaceManifestRows(db, {
      id: `sharing-${index}`,
      revision: 1,
      action: { kind: "materialize" },
    });
    assert(loaded.records, "A fresh reader must receive the baseline records");
    expect(decodeLocalWorkspaceTree(loaded.records)).toEqual(records);
  }
});

it("accepts a prepared tree with only the projection root flip inside the writer transaction", () => {
  using cleanup = new DisposableStack();
  using db = new DatabaseSync(":memory:");
  const id = randomUUID();
  mutateLocalWorkspaceProjection(db, id, {
    kind: "create",
    row: localWorkspaceProjectionFixture(id, "/synthetic"),
  });
  const records = tree("a");
  prepareTreePacks(db, records);
  const counters = trackSqliteStatementExecutions(db, ["nodeWrites", "rootFlip"], (sql) => {
    if (
      /^(?:insert|update|delete)\b/i.test(sql) &&
      /local_workspace_(?:tree_packs|manifest_nodes)/i.test(sql)
    ) {
      return "nodeWrites";
    }
    if (/^update\b/i.test(sql) && /local_workspace_projections/i.test(sql)) {
      return "rootFlip";
    }
    return null;
  });
  cleanup.defer(counters.restore);
  prepareTreePacks(db, records);
  expect(counters.counts.nodeWrites).toBe(0);
  mutateLocalWorkspaceProjection(db, id, {
    kind: "update",
    revision: 0,
    patch: { checkpoint_json: null },
    manifest: {
      previousRoot: null,
      resultingRoot: localWorkspaceManifestRootReference(records, "a".repeat(40)),
      treeRoot: records.get("")!.treeRef,
      records: [],
      removed: [],
      replace: true,
    },
  });
  expect(counters.counts).toEqual({ nodeWrites: 0, rootFlip: 1 });
  expect(
    decodeLocalWorkspaceTree(
      readLocalWorkspaceTree(db, localWorkspaceDigestBytes(records.get("")!.treeRef)),
    ),
  ).toEqual(records);
});

it("sweeps unreachable content while retaining baseline, previous and pending roots and newly reused content", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state"));
  const id = randomUUID();
  const baseline = createLocalWorkspaceManifestTree(
    Array.from({ length: 300 }, (_, index) => [
      { path: `dir-${index}`, type: "directory" as const },
      {
        path: `dir-${index}/entry.txt`,
        type: "file" as const,
        mode: 0o644,
        size: 1,
        sha256: "a".repeat(64),
      },
    ]).flat(),
  );
  const previous = tree("b");
  const pending = tree("c");
  const abandoned = tree("d");
  const reused = tree("e");
  mutateLocalWorkspaceProjection(db, id, {
    kind: "create",
    row: localWorkspaceProjectionFixture(id, "/synthetic"),
  });
  for (const records of [baseline, previous, pending, abandoned, reused]) {
    prepareTreePacks(db, records);
  }
  const livePaths = prepareLocalWorkspaceSourcePathSet('["entry.txt"]');
  const orphanPaths = prepareLocalWorkspaceSourcePathSet('["abandoned.txt"]');
  const reusedPaths = prepareLocalWorkspaceSourcePathSet('["reused.txt"]');
  for (const paths of [livePaths, orphanPaths, reusedPaths]) {
    prepareLocalWorkspaceContentInDatabase(db, { paths });
  }
  const root = (records: ReturnType<typeof tree>) => records.get("")!.treeRef;
  const reference = (records: ReturnType<typeof tree>) =>
    localWorkspaceManifestRootReference(records, "a".repeat(40));
  // The pending checkpoint owns both sides even when neither is the current baseline.
  const checkpoint = {
    version: 1,
    kind: "scan",
    previousRoot: reference(previous),
    resultingRoot: reference(pending),
    previousTreeRoot: root(previous),
    treeRoot: root(pending),
    records: [],
    removed: [],
    baseManifestRaw: "",
    baseManifestRef: "",
    currentManifestRaw: "",
    currentManifestRef: "",
    buildCacheInputs: [],
  };
  mutateLocalWorkspaceProjection(db, id, {
    kind: "update",
    revision: 0,
    patch: {
      tree_root_digest: localWorkspaceDigestBytes(root(baseline)),
      source_paths_digest: localWorkspaceDigestBytes(livePaths.digest),
      baseline_ref: reference(baseline),
      pending_ref: "refs/openclaw/results/synthetic",
      pending_target: "canonical",
      checkpoint_json: JSON.stringify(checkpoint),
    },
  });
  expect(beginLocalWorkspaceSweepInDatabase(db)).toBe(1);
  const epoch = beginLocalWorkspaceSweepInDatabase(db);
  expect(epoch).toBe(2);
  const packCount = Number(
    db.prepare("SELECT count(*) AS n FROM local_workspace_tree_packs").get()!.n,
  );
  const reads = trackSqliteStatementExecutions(db, ["packs"], (sql) =>
    /^select\b/i.test(sql) && sql.includes('from "local_workspace_tree_packs"') ? "packs" : null,
  );
  const candidates = readLocalWorkspaceSweepCandidates(db, epoch);
  reads.restore();
  // Every old digest is returned by candidate discovery; traversal already knows its lookup keys.
  expect(reads.blobBytes.packs).toBe(packCount * 32);
  expect(candidates.packs).toHaveLength(4);
  expect(candidates.paths).toHaveLength(2);
  // A writer reusing content after the snapshot protects it with the current epoch.
  prepareTreePacks(db, reused, reusedPaths);
  deleteLocalWorkspaceSweepBatchInDatabase(db, epoch, candidates);
  for (const records of [baseline, previous, pending, reused]) {
    expect(
      decodeLocalWorkspaceTree(
        readLocalWorkspaceTree(db, localWorkspaceDigestBytes(root(records))),
      ),
    ).toEqual(records);
  }
  expect(() => readLocalWorkspaceTree(db, localWorkspaceDigestBytes(root(abandoned)))).toThrow(
    "baseline nodes are missing",
  );
  expect(readLocalWorkspaceSourcePaths(db, localWorkspaceDigestBytes(livePaths.digest))).toBe(
    '["entry.txt"]',
  );
  expect(readLocalWorkspaceSourcePaths(db, localWorkspaceDigestBytes(reusedPaths.digest))).toBe(
    '["reused.txt"]',
  );
  expect(() =>
    readLocalWorkspaceSourcePaths(db, localWorkspaceDigestBytes(orphanPaths.digest)),
  ).toThrow("source path set is missing");
});
