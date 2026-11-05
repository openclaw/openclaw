import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
} from "./local-workspace-manifest-tree.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import { localWorkspaceProjectionFixture } from "./local-workspace-store.test-support.js";

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
