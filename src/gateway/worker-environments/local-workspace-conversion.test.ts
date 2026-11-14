import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { localWorkspaceDigestBytes } from "./local-workspace-cas.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
  updateLocalWorkspaceManifestTree,
} from "./local-workspace-manifest-tree.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import { localWorkspaceProjectionFixture } from "./local-workspace-store.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
let root: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  root = dirs.make("workspace-conversion-");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
});
const baseCommit = "a".repeat(40);
const reference = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;

it("converts an accepted empty runtime directory without changing its manifest or root reference", async () => {
  const worktreeId = randomUUID();
  // A historical receipt can predate the runtime ownership of this empty directory.
  const raw = JSON.stringify({
    version: 1,
    baseCommit,
    entries: [
      { path: ".artifacts", type: "directory", mode: 0o700 },
      { path: ".artifacts/dist-artifacts.lock", type: "directory", mode: 0o700 },
    ],
  });
  const baselineRef = reference(raw);
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const row = await store.create({
      ...localWorkspaceProjectionFixture(worktreeId, root),
      baseline_json: raw,
      baseline_ref: baselineRef,
    });
    const prepared = await store.manifest(row, { kind: "convert" });
    assert(prepared.kind === "replace");
    const converted = await store.accept(prepared.update);
    expect(converted.baseline_ref).toBe(baselineRef);
    expect(converted.tree_root_digest).not.toBeNull();
    expect(converted.baseline_json).toBeNull();
    expect(await store.manifest(converted, { kind: "materialize" })).toEqual({
      kind: "materialize",
      rawManifest: raw,
      manifestRef: baselineRef,
    });
  });
});

it.each(["legacy", "v31"] as const)(
  "keeps %s conversion sources and publishes nothing when the rebuilt reference differs",
  async (format) => {
    const worktreeId = randomUUID();
    const records = createLocalWorkspaceManifestTree([{ path: "empty", type: "directory" }]);
    // The valid legacy digest owns bytes that canonical serialization would normalize.
    const raw = JSON.stringify({
      version: 1,
      baseCommit,
      entries: [{ path: "empty", type: "directory", mode: 0o755 }],
    });
    const baselineRef = format === "legacy" ? reference(raw) : `sha256:${"f".repeat(64)}`;
    expect(localWorkspaceManifestRootReference(records, baseCommit)).not.toBe(baselineRef);
    await withLocalWorkspaceStore({ worktreeId, env }, (store) =>
      store.create({
        ...localWorkspaceProjectionFixture(worktreeId, root),
        baseline_json: format === "legacy" ? raw : null,
        baseline_ref: baselineRef,
      }),
    );
    const { db } = openOpenClawStateDatabase({ env });
    for (const record of records.values()) {
      db.prepare(
        "INSERT INTO local_workspace_manifest_nodes (worktree_id, path, node_json) VALUES (?, ?, ?)",
      ).run(worktreeId, record.node.path, JSON.stringify(record));
    }
    const source = () => ({
      row: db
        .prepare("SELECT * FROM local_workspace_projections WHERE worktree_id = ?")
        .get(worktreeId),
      nodes: db
        .prepare("SELECT * FROM local_workspace_manifest_nodes WHERE worktree_id = ? ORDER BY path")
        .all(worktreeId),
      treeNodes: db.prepare("SELECT count(*) AS n FROM local_workspace_tree_packs").get(),
    });
    const before = source();
    await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
      expect(await store.manifest(store.get()!, { kind: "convert" })).toEqual({ kind: "rescan" });
    });
    expect(source()).toEqual(before);
  },
);

it("converts a v31 projection online without changing its root and recovers its saved checkpoint after restart", async () => {
  const worktreeId = randomUUID();
  const conversionBaseCommit = "a".repeat(40);
  const records = createLocalWorkspaceManifestTree([
    { path: "entry.txt", type: "file", mode: 0o644, size: 4, sha256: "a".repeat(64) },
  ]);
  const previousRoot = localWorkspaceManifestRootReference(records, conversionBaseCommit);
  const previousTreeRoot = records.get("")!.treeRef;
  const legacyRows = [...records.values()].map((record) =>
    Object.assign({}, record, {
      canonicalIdentity: "gateway:1:2:4:5:6",
      projectionIdentity: "gateway:1:3:4:5:6",
    }),
  );
  const changed = updateLocalWorkspaceManifestTree(records, [
    {
      path: "entry.txt",
      node: { path: "entry.txt", type: "file", mode: 0o644, size: 4, sha256: "b".repeat(64) },
    },
  ]);
  const resultingRoot = localWorkspaceManifestRootReference(records, conversionBaseCommit);
  const checkpoint = {
    version: 1 as const,
    kind: "scan" as const,
    previousRoot,
    resultingRoot,
    ...changed,
    baseManifestRaw: serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: conversionBaseCommit,
      entries: [legacyRows.find((record) => record.node.path === "entry.txt")!.node].filter(
        (node) => node.type !== "directory",
      ),
    }),
    baseManifestRef: "sha256:legacy-base",
    currentManifestRaw: serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: conversionBaseCommit,
      entries: [{ path: "entry.txt", type: "file", mode: 0o644, size: 4, sha256: "b".repeat(64) }],
    }),
    currentManifestRef: "sha256:legacy-result",
    buildCacheInputs: [],
  };
  const savedCheckpoint = JSON.stringify(checkpoint);
  await withLocalWorkspaceStore({ worktreeId, env }, (store) =>
    store.create({
      ...localWorkspaceProjectionFixture(worktreeId, root),
      source_paths_json: '["entry.txt"]',
      baseline_ref: previousRoot,
      pending_ref: "refs/openclaw/results/legacy-checkpoint",
      pending_target: "canonical",
      checkpoint_json: savedCheckpoint,
    }),
  );
  const database = openOpenClawStateDatabase({ env });
  for (const record of legacyRows) {
    database.db
      .prepare(
        "INSERT INTO local_workspace_manifest_nodes (worktree_id, path, node_json) VALUES (?, ?, ?)",
      )
      .run(worktreeId, record.node.path, JSON.stringify(record));
  }
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const prepared = await store.manifest(store.get()!, { kind: "convert" });
    assert(prepared.kind === "replace");
    const converted = await store.accept(prepared.update);
    expect(converted.baseline_ref).toBe(previousRoot);
    expect(
      Buffer.from(converted.tree_root_digest!).equals(localWorkspaceDigestBytes(previousTreeRoot)),
    ).toBe(true);
    expect(converted.checkpoint_json).toBe(savedCheckpoint);
    expect(converted.pending_target).toBe("canonical");
  });
  expect(
    database.db
      .prepare("SELECT count(*) AS count FROM local_workspace_manifest_nodes WHERE worktree_id = ?")
      .get(worktreeId)!.count,
  ).toBe(0);
  await closeOpenClawStateDatabaseAsync();
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const selected = store.get()!;
    const restored = JSON.parse(selected.checkpoint_json!) as typeof checkpoint;
    expect(restored.previousRoot).toBe(selected.baseline_ref);
    const accepted = await store.update(selected, { pending_target: null }, undefined, restored);
    expect(accepted.baseline_ref).toBe(resultingRoot);
    const materialized = await store.manifest(accepted, { kind: "materialize" });
    expect(materialized).toMatchObject({
      kind: "materialize",
      rawManifest: checkpoint.currentManifestRaw,
    });
  });
});
