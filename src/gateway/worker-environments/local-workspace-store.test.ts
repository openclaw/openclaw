import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { inflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  WORKTREE_CREATE_LEASE_SCOPE,
  WORKTREE_MUTATION_LEASE_SCOPE,
} from "../../agents/worktrees/capacity-contract.js";
import { requireGit } from "../../agents/worktrees/git.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  type SqliteWorkerReply,
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
} from "../../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import * as stateRead from "../../state/openclaw-state-read-operation.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import {
  localWorkspaceDigestBytes,
  prepareLocalWorkspaceTreePacks,
  type LocalWorkspacePreparation,
} from "./local-workspace-cas.js";
import {
  prepareLocalWorkspaceContentInDatabase,
  readLocalWorkspaceTree,
} from "./local-workspace-cas.kernel.js";
import {
  executeLocalWorkspaceManifestRead,
  readLocalWorkspaceManifestRows,
} from "./local-workspace-manifest-scan.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
  updateLocalWorkspaceManifestTree,
} from "./local-workspace-manifest-tree.js";
import { readLocalWorkspaceCommit } from "./local-workspace-publication.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import {
  mutateLocalWorkspaceProjection as mutateProjection,
  readLocalWorkspaceProjectionInDatabase as readProjectionInDatabase,
} from "./local-workspace-store.kernel.js";
import {
  localWorkspaceProjectionFixture,
  readLocalWorkspaceProjection,
} from "./local-workspace-store.test-support.js";
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
  root = dirs.make("openclaw-local-workspace-worker-");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
});
afterEach(() => vi.restoreAllMocks());

function readManifestRows(db: EngineConnection, worktreeId: string) {
  const projection = readProjectionInDatabase(db, worktreeId);
  return projection?.tree_root_digest
    ? [...readLocalWorkspaceTree(db, projection.tree_root_digest).values()]
        .map((record) => ({ path: record.node.path, node_json: JSON.stringify(record) }))
        .toSorted((left, right) => left.path.localeCompare(right.path))
    : [];
}

function prepareTreePacks(
  db: EngineConnection,
  records: Parameters<typeof prepareLocalWorkspaceTreePacks>[0],
) {
  for (const batch of prepareLocalWorkspaceTreePacks(records)) {
    const preparation = deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation;
    prepareLocalWorkspaceContentInDatabase(db, preparation);
  }
}

it("looks up workspace identity without returning pending recovery payloads", async () => {
  const worktreeId = randomUUID();
  const fixture = {
    ...localWorkspaceProjectionFixture(worktreeId, root),
    lifecycle_revision: "workspace-generation",
    pending_ref: "refs/openclaw/results/pending",
    journal_json: "{}",
    journal_pack: Buffer.alloc(1024 * 1024, 7),
  };
  await withLocalWorkspaceStore({ worktreeId, env }, (store) => store.create(fixture));
  const result = await executeExistingOpenClawStateRead(
    { env },
    {
      type: "localWorkspace.byProjectionPath",
      input: { projectionPath: fixture.projection_path },
    },
    { current: true, live: true },
  );
  expect(serialize(result).byteLength).toBeLessThan(1024);
  expect(result?.projection).toEqual({
    worktree_id: worktreeId,
    agent_id: fixture.agent_id,
    session_key: fixture.session_key,
    session_id: fixture.session_id,
    lifecycle_revision: fixture.lifecycle_revision,
  });
  const recovered = await readLocalWorkspaceProjection(worktreeId, env);
  expect(recovered?.pending_ref).toBe(fixture.pending_ref);
  expect(Buffer.from(recovered!.journal_pack!)).toEqual(fixture.journal_pack);
});

it.each(["absent", "same", "distinct"] as const)(
  "checks each workspace authority once per synchronous assertion (%s worker guard)",
  async (kind) => {
    const current = vi.fn();
    const worker = kind === "same" ? current : vi.fn();
    let retained: (() => void) | undefined;
    await withLocalWorkspaceStore(
      {
        worktreeId: randomUUID(),
        env,
        assertCurrent: current,
        workerAuthority: kind === "absent" ? undefined : { assertCurrent: worker },
      },
      async (store) => {
        current.mockClear();
        worker.mockClear();
        store.assertCurrent();
        expect(current).toHaveBeenCalledOnce();
        if (kind === "distinct") {
          expect(worker).toHaveBeenCalledOnce();
        }
        retained = store.assertCurrent;
      },
    );
    expect(retained).toBeDefined();
    expect(retained).toThrow();
  },
);

it("distinguishes committed deletion from unknown or mismatched mutation coverage", () => {
  const worktreeId = randomUUID();
  const previous = { ...localWorkspaceProjectionFixture(worktreeId, root), revision: 0 };
  const mutation = { kind: "delete" as const, revision: 0 };
  expect(readLocalWorkspaceCommit(null, worktreeId, mutation, previous)).toBeUndefined();
  expect(() => readLocalWorkspaceCommit(undefined, worktreeId, mutation, previous)).toThrow(
    "coverage is incomplete",
  );
  for (const receipt of [
    null,
    { worktree_id: randomUUID(), revision: 1 },
    { worktree_id: worktreeId, revision: 2 },
  ]) {
    expect(() =>
      readLocalWorkspaceCommit(
        receipt,
        worktreeId,
        { kind: "update", revision: 0, patch: {} },
        previous,
      ),
    ).toThrow("commit identity is invalid");
  }
});

it("keeps mutation preconditions and receipts small without trimming stored payloads", () => {
  using cleanup = new DisposableStack();
  const database = new DatabaseSync(":memory:");
  cleanup.defer(() => database.close());
  const worktreeId = randomUUID();
  const baseline = JSON.stringify({ synthetic: "x".repeat(3 * 1024 * 1024) });
  const journalPack = new Uint8Array(3 * 1024 * 1024).fill(7);
  const initial = {
    ...localWorkspaceProjectionFixture(worktreeId, root),
    baseline_json: baseline,
    baseline_ref: "sha256:synthetic",
    journal_json: "{}",
    journal_pack: journalPack,
  };
  const reads = trackSqliteStatementExecutions(database, ["precondition", "receipt"], (sql) =>
    !sql.includes("local_workspace_projections")
      ? null
      : /^select\b/i.test(sql)
        ? "precondition"
        : /\breturning\b/i.test(sql)
          ? "receipt"
          : null,
  );
  cleanup.defer(reads.restore);
  expect(mutateProjection(database, worktreeId, { kind: "create", row: initial })).toEqual({
    worktree_id: worktreeId,
    revision: 0,
  });
  expect(() => mutateProjection(database, worktreeId, { kind: "create", row: initial })).toThrow(
    "Local workspace binding already exists",
  );
  const updated = mutateProjection(database, worktreeId, {
    kind: "update",
    revision: 0,
    patch: { paused_runtimes_json: "[]" },
  });
  expect(updated).toEqual({ worktree_id: worktreeId, revision: 1 });
  expect(() => mutateProjection(database, worktreeId, { kind: "delete", revision: 1 })).toThrow(
    "Local workspace has unsettled edits",
  );
  expect(reads.rowCounts.precondition).toBe(3);
  expect(reads.rowCounts.receipt).toBe(2);
  expect(reads.textBytes.precondition + reads.blobBytes.precondition).toBeLessThan(1024);
  expect(reads.textBytes.receipt + reads.blobBytes.receipt).toBeLessThan(1024);
  reads.restore();
  const persisted = readProjectionInDatabase(database, worktreeId);
  assert(persisted?.journal_pack);
  expect(persisted).toMatchObject({ revision: 1, paused_runtimes_json: "[]" });
  expect(persisted.baseline_json).toBe(baseline);
  expect(Buffer.from(persisted.journal_pack).equals(journalPack)).toBe(true);
  mutateProjection(database, worktreeId, {
    kind: "update",
    revision: 1,
    patch: { journal_json: "", journal_pack: new Uint8Array(), pending_ref: "" },
  });
  mutateProjection(database, worktreeId, { kind: "delete", revision: 2 });
  expect(readProjectionInDatabase(database, worktreeId)).toBeUndefined();
});

it("preserves the acknowledged row when a stale revision conflicts", async () => {
  const worktreeId = randomUUID();
  let committed: Awaited<ReturnType<typeof readLocalWorkspaceProjection>>;
  let retainedGuard: (() => void) | undefined;
  await expect(
    withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
      retainedGuard = store.assertCurrent;
      const initial = await store.create(localWorkspaceProjectionFixture(worktreeId, root));
      committed = await store.update(initial, {
        baseline_ref: "sha256:accepted",
        baseline_json: "{}",
      });
      expect(store.get()).toEqual(committed);
      const sql = observeHostDataSql();
      try {
        store.assertCurrent();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      await store.update(initial, { baseline_ref: "sha256:stale", baseline_json: "{}" });
    }),
  ).rejects.toThrow("Local workspace binding changed");
  assert(retainedGuard);
  expect(retainedGuard).toThrow();
  expect(await readLocalWorkspaceProjection(worktreeId, env)).toEqual(committed);
  expect(committed).toMatchObject({ revision: 1, baseline_ref: "sha256:accepted" });
});

it("cancels an accepted manifest read when the workspace lease ends", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  const completion = Promise.withResolvers<never>();
  const startRead = stateRead.startOpenClawStateReadOperation;
  vi.spyOn(stateRead, "startOpenClawStateReadOperation").mockImplementation(
    (command, selection) => {
      if (command.type !== "localWorkspace.manifest") {
        return startRead(command, selection);
      }
      started.resolve(selection.signal);
      return completion.promise;
    },
  );
  const worktreeId = randomUUID();
  const reason = new Error("workspace lease cancelled during manifest read");
  const outcome = withLocalWorkspaceStore(
    { worktreeId, env, signal: controller.signal },
    async (store) => {
      const row = await store.create(localWorkspaceProjectionFixture(worktreeId, root));
      await store.manifest(row, { kind: "materialize" });
    },
  ).catch((error: unknown) => error);
  const readSignal = await started.promise;
  controller.abort(reason);
  try {
    expect(readSignal.aborted).toBe(true);
  } finally {
    completion.reject(reason);
    expect(await outcome).toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
  }
});

it("materializes a manifest snapshot after its database closes", async () => {
  const database = new DatabaseSync(":memory:");
  const worktreeId = randomUUID();
  const records = createLocalWorkspaceManifestTree([
    { path: "entry.txt", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) },
  ]);
  const action = { kind: "materialize" as const };
  const snapshot = (() => {
    try {
      mutateProjection(database, worktreeId, {
        kind: "create",
        row: localWorkspaceProjectionFixture(worktreeId, root),
      });
      prepareTreePacks(database, records);
      mutateProjection(database, worktreeId, {
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
      return readLocalWorkspaceManifestRows(database, { id: worktreeId, revision: 1, action });
    } finally {
      database.close();
    }
  })();
  // The read scope is closed: materialization must own all facts, not a live SQLite cursor.
  const value = await executeLocalWorkspaceManifestRead(snapshot, action);
  expect(value).toMatchObject({
    kind: "materialize",
    rawManifest: JSON.stringify({
      version: 1,
      baseCommit: "a".repeat(40),
      entries: [{ path: "entry.txt", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) }],
    }),
  });
});

it("accepts manifest nodes and checkpoint headers atomically and preserves them on rollback", async () => {
  const worktreeId = randomUUID();
  const database = openOpenClawStateDatabase({ env });
  const records = createLocalWorkspaceManifestTree([
    { path: "old.txt", type: "file", mode: 0o644, size: 3, sha256: "a".repeat(64) },
    { path: "kept.txt", type: "file", mode: 0o644, size: 4, sha256: "b".repeat(64) },
  ]);
  const acceptedRoot = localWorkspaceManifestRootReference(records, null);
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const row = await store.create({
      ...localWorkspaceProjectionFixture(worktreeId, root),
      baseline_ref: "sha256:legacy",
      baseline_json: "retained legacy document",
    });
    const acknowledged = await store.update(
      row,
      {
        checkpoint_json: "accepted receipt",
        baseline_ref: "sha256:superseded",
        baseline_json: "superseded legacy document",
      },
      undefined,
      {
        previousRoot: "sha256:legacy",
        resultingRoot: acceptedRoot,
        records: [...records.values()],
        removed: [],
        replace: true,
      },
    );
    expect(acknowledged).toMatchObject({ baseline_ref: acceptedRoot, baseline_json: null });
  });
  const acceptedNodes = readManifestRows(database.db, worktreeId);
  expect(acceptedNodes.map((row) => row.path)).toEqual(["", "kept.txt", "old.txt"]);
  const accepted = await readLocalWorkspaceProjection(worktreeId, env);
  expect(accepted).toMatchObject({
    baseline_ref: acceptedRoot,
    baseline_json: null,
    checkpoint_json: "accepted receipt",
    revision: 1,
  });
  const next = updateLocalWorkspaceManifestTree(records, [{ path: "old.txt" }]);
  const nextRoot = localWorkspaceManifestRootReference(records, null);
  database.db
    .exec(`CREATE TRIGGER refuse_manifest_header BEFORE UPDATE ON local_workspace_projections
    WHEN NEW.worktree_id = '${worktreeId}'
    BEGIN SELECT RAISE(ABORT, 'synthetic manifest acceptance interruption'); END;`);
  try {
    await expect(
      withLocalWorkspaceStore({ worktreeId, env }, (store) =>
        store.update(store.get()!, { checkpoint_json: "next receipt" }, undefined, {
          previousRoot: acceptedRoot,
          resultingRoot: nextRoot,
          ...next,
        }),
      ),
    ).rejects.toThrow("synthetic manifest acceptance interruption");
    expect(readManifestRows(database.db, worktreeId)).toEqual(acceptedNodes);
    expect(await readLocalWorkspaceProjection(worktreeId, env)).toEqual(accepted);
  } finally {
    database.db.exec("DROP TRIGGER refuse_manifest_header;");
  }
  await expect(
    withLocalWorkspaceStore({ worktreeId, env }, (store) =>
      store.update(store.get()!, {}, undefined, {
        previousRoot: "sha256:stale",
        resultingRoot: nextRoot,
        ...next,
      }),
    ),
  ).rejects.toThrow("manifest baseline changed");
  expect(readManifestRows(database.db, worktreeId)).toEqual(acceptedNodes);
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const row = await store.update(store.get()!, { checkpoint_json: "next receipt" }, undefined, {
      previousRoot: acceptedRoot,
      resultingRoot: nextRoot,
      ...next,
    });
    expect(row).toMatchObject({ baseline_ref: nextRoot, checkpoint_json: "next receipt" });
  });
  expect(readManifestRows(database.db, worktreeId).map((row) => row.path)).toEqual([
    "",
    "kept.txt",
  ]);
});

it("keeps prepared baseline replacement atomic through rollback and a lost commit reply", async () => {
  const worktreeId = randomUUID();
  const rawManifest = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit: "a".repeat(40),
    entries: [{ path: "src/next.txt", type: "file", mode: 0o644, size: 4, sha256: "b".repeat(64) }],
    directories: ["src"],
  });
  const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
  const document = { rawManifest, manifestRef, buildCacheInputs: [] };
  const initial = await withLocalWorkspaceStore({ worktreeId, env }, (store) =>
    store.create({
      ...localWorkspaceProjectionFixture(worktreeId, root),
      baseline_json: rawManifest,
      baseline_ref: manifestRef,
    }),
  );
  const database = openOpenClawStateDatabase({ env });
  const nodePaths = () => {
    const projection = readProjectionInDatabase(database.db, worktreeId);
    return projection?.tree_root_digest
      ? [...readLocalWorkspaceTree(database.db, projection.tree_root_digest).keys()].toSorted()
      : [];
  };
  const replace = () =>
    withLocalWorkspaceStore({ worktreeId, env }, (store) =>
      store.update(
        store.get()!,
        {
          pending_ref: "refs/openclaw/results/accepted",
          // Manifest publication must override obsolete full-document fields in the patch.
          baseline_ref: "sha256:superseded",
          baseline_json: "superseded",
        },
        undefined,
        document,
      ),
    );
  database.db
    .exec(`CREATE TRIGGER refuse_prepared_baseline BEFORE UPDATE ON local_workspace_projections
    WHEN NEW.worktree_id = '${worktreeId}'
    BEGIN SELECT RAISE(ABORT, 'synthetic prepared baseline interruption'); END;`);
  try {
    await expect(replace()).rejects.toThrow("synthetic prepared baseline interruption");
    expect(await readLocalWorkspaceProjection(worktreeId, env)).toEqual(initial);
    expect(nodePaths()).toEqual([]);
  } finally {
    database.db.exec("DROP TRIGGER refuse_prepared_baseline;");
  }
  let writes = 0;
  const lostReply = probe.command(stateWorker, async (command, executeOptions, scope) => {
    const reply = await scope.execute(command, executeOptions);
    if (command.type === "localWorkspace.mutate") {
      writes++;
      throw new Error("Synthetic prepared baseline reply lost after commit");
    }
    return reply;
  });
  const acknowledged = await replace();
  lostReply.mockRestore();
  expect(writes).toBe(1);
  expect(acknowledged).toMatchObject({
    revision: initial.revision + 1,
    baseline_json: null,
    pending_ref: "refs/openclaw/results/accepted",
  });
  expect(acknowledged.baseline_ref).not.toBe(manifestRef);
  expect(await readLocalWorkspaceProjection(worktreeId, env)).toEqual(acknowledged);
  expect(nodePaths()).toEqual(["", "src", "src/next.txt"]);
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const materialized = await store.manifest(store.get()!, { kind: "materialize" });
    assert(materialized.kind === "materialize");
    expect(JSON.parse(materialized.rawManifest)).toMatchObject(JSON.parse(rawManifest));
  });
});

it("accepts worker-prepared observations without consuming edits or replaying stale metadata", async () => {
  const worktreeId = randomUUID();
  const canonical = dirs.make("openclaw-local-workspace-observation-");
  const unchangedPaths = Array.from({ length: 32 }, (_, index) => `kept-${index}.txt`);
  const baselinePaths = [...unchangedPaths, "edited.txt"];
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const entryPath of baselinePaths) {
    await fs.writeFile(path.join(canonical, entryPath), "before");
  }
  await requireGit(canonical, ["init", "--quiet"]);
  const rawManifest = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit: "a".repeat(40),
    entries: baselinePaths.map((entryPath) => ({
      path: entryPath,
      type: "file" as const,
      mode: 0o644,
      size: 6,
      sha256: hash("before"),
    })),
    directories: [],
  });
  const initial = await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const row = await store.create({
      ...localWorkspaceProjectionFixture(worktreeId, root),
      projection_path: canonical,
      source_paths_json: JSON.stringify(baselinePaths),
    });
    return store.update(row, {}, undefined, {
      rawManifest,
      manifestRef: `sha256:${hash(rawManifest)}`,
      buildCacheInputs: [],
    });
  });
  const addedPath = ".artifacts/build-cache-inputs/added.txt";
  await fs.mkdir(path.dirname(path.join(canonical, addedPath)), { recursive: true });
  await fs.writeFile(path.join(canonical, addedPath), "admitted");
  await fs.writeFile(path.join(canonical, "edited.txt"), "after");
  await requireGit(canonical, ["add", "--force", "--", addedPath]);
  const action = { kind: "scan" as const, target: "projection" as const, canonicalRoot: canonical };
  const database = openOpenClawStateDatabase({ env });
  const initialNodes = readManifestRows(database.db, worktreeId);
  const pending = {
    pending_ref: "refs/openclaw/results/retained",
    checkpoint_json: "retained checkpoint receipt",
  };
  await expect(
    withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
      const scan = await store.manifest(store.get()!, action);
      assert(scan.kind === "scan");
      // Count expanded tree records crossing the worker boundary, regardless of field name.
      // Unchanged metadata must remain encoded instead of cloning the whole inventory on host.
      const expandedRecords = Object.values(scan).reduce<number>(
        (count, value) =>
          count +
          (Array.isArray(value)
            ? value.filter((entry) => entry && typeof entry === "object" && "node" in entry).length
            : 0),
        0,
      );
      expect(expandedRecords).toBeLessThan(unchangedPaths.length);
      assert(scan.observation);
      expect(scan.resultingRoot).not.toBe(initial.baseline_ref);
      await store.update(store.get()!, pending);
      await store.accept(scan.observation);
    }),
  ).rejects.toThrow("Local workspace binding changed");
  expect(readManifestRows(database.db, worktreeId)).toEqual(initialNodes);
  expect(await readLocalWorkspaceProjection(worktreeId, env)).toMatchObject({
    ...pending,
    revision: initial.revision + 1,
    baseline_ref: initial.baseline_ref,
    source_paths_json: initial.source_paths_json,
  });
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const scan = await store.manifest(store.get()!, action);
    assert(scan.kind === "scan" && scan.observation);
    const observed = await store.accept(scan.observation);
    expect(observed).toMatchObject({
      ...pending,
      revision: initial.revision + 2,
      baseline_ref: initial.baseline_ref,
      baseline_json: null,
    });
    expect(JSON.parse(observed.source_paths_json)).toContain(addedPath);
    const persisted = readManifestRows(database.db, worktreeId);
    // Path admission cannot mutate the immutable accepted content or consume pending edits.
    expect(persisted).toEqual(initialNodes);
    expect(observed.source_paths_digest).not.toBeNull();
    const baseline = await store.manifest(observed, { kind: "materialize" });
    assert(baseline.kind === "materialize");
    expect(JSON.parse(baseline.rawManifest)).toEqual(JSON.parse(rawManifest));

    const accepted = await store.update(observed, { pending_ref: null }, undefined, scan);
    expect(accepted.baseline_ref).toBe(scan.resultingRoot);
    expect(accepted.canonical_fingerprints).not.toBeNull();
    const materialized = await store.manifest(accepted, { kind: "materialize" });
    assert(materialized.kind === "materialize");
    expect(JSON.parse(materialized.rawManifest).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "edited.txt", sha256: hash("after"), size: 5 }),
        expect.objectContaining({ path: addedPath, sha256: hash("admitted"), size: 8 }),
        expect.objectContaining({ path: "kept-0.txt", sha256: hash("before"), size: 6 }),
      ]),
    );
  });
});

it.each([
  { scope: WORKTREE_CREATE_LEASE_SCOPE, fault: "expired" },
  { scope: WORKTREE_CREATE_LEASE_SCOPE, fault: "replaced" },
  { scope: WORKTREE_MUTATION_LEASE_SCOPE, fault: "expired" },
  { scope: WORKTREE_MUTATION_LEASE_SCOPE, fault: "replaced" },
])("refuses projection writes under a $fault $scope lease", async ({ scope, fault }) => {
  const worktreeId = randomUUID();
  const database = openOpenClawStateDatabase({ env });
  const context = captureOpenClawStateWorkerContext({ env });
  let revoked = false;
  let aboutToUpdate = false;
  let retainedIdentity: OpenClawStateLeaseIdentity | undefined;
  probe.command(stateWorker, async (command, executeOptions, worker) => {
    if (command.type === "localWorkspace.mutate" && aboutToUpdate) {
      aboutToUpdate = false;
      assert(retainedIdentity);
      const changed = database.db
        .prepare(
          fault === "expired"
            ? "UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ? AND owner = ?"
            : "UPDATE state_leases SET owner = 'synthetic-successor' WHERE scope = ? AND lease_key = ? AND owner = ?",
        )
        .run(retainedIdentity.scope, retainedIdentity.key, retainedIdentity.owner);
      expect(changed.changes).toBe(1);
      revoked = true;
    }
    return worker.execute(command, executeOptions);
  });
  try {
    await expect(
      withOpenClawStateLeaseAsync(
        { scope, key: worktreeId, leaseMs: 60_000, waitMs: 0 },
        context,
        (lease, identity) => {
          retainedIdentity = identity;
          return withLocalWorkspaceStore(
            { worktreeId, env, workerAuthority: { leaseSet: { context, leases: [lease] } } },
            async (store) => {
              const initial = await store.create(localWorkspaceProjectionFixture(worktreeId, root));
              aboutToUpdate = true;
              await store.update(initial, { pending_ref: "refs/openclaw/results/refused" });
            },
          );
        },
      ),
    ).rejects.toThrow(/lease/iu);
    expect(revoked).toBe(true);
    expect(await readLocalWorkspaceProjection(worktreeId, env)).toMatchObject({
      revision: 0,
      pending_ref: null,
    });
  } finally {
    database.db
      .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
      .run(scope, worktreeId);
  }
});

it("adopts native committed facts after reply loss without replaying the mutation", async () => {
  const worktreeId = randomUUID();
  await withLocalWorkspaceStore({ worktreeId, env }, (store) =>
    store.create(localWorkspaceProjectionFixture(worktreeId, root)),
  );
  let writes = 0;
  const lostReply = probe.command(stateWorker, async (command, executeOptions, scope) => {
    const result = await scope.execute(command, executeOptions);
    if (command.type === "localWorkspace.mutate") {
      writes += 1;
      throw new Error("Synthetic local workspace reply lost after native commit");
    }
    return result;
  });
  const pendingRef = "refs/openclaw/results/accepted";
  const acknowledged = await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const row = await store.update(
      { ...store.get()!, base_commit: "f".repeat(40) },
      { pending_ref: pendingRef },
    );
    expect(store.get()).toEqual(row);
    return row;
  });
  expect(writes).toBe(1);
  expect(acknowledged).toMatchObject({
    revision: 1,
    pending_ref: pendingRef,
    base_commit: "a".repeat(40),
  });
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    expect(store.get()).toEqual(acknowledged);
    await expect(store.delete(store.get()!)).rejects.toThrow("unsettled edits");
  });
  expect(await readLocalWorkspaceProjection(worktreeId, env)).toEqual(acknowledged);
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const cleared = await store.update(store.get()!, { pending_ref: null });
    await store.delete(cleared);
    expect(store.get()).toBeUndefined();
  });
  lostReply.mockRestore();
  expect(writes).toBe(3);
  expect(await readLocalWorkspaceProjection(worktreeId, env)).toBeUndefined();
});

it("recovers an oversized committed row after reply loss without replaying or trimming bytes", async () => {
  const worktreeId = randomUUID();
  await withLocalWorkspaceStore({ worktreeId, env }, (store) =>
    store.create(localWorkspaceProjectionFixture(worktreeId, root)),
  );
  const baseline = JSON.stringify({ synthetic: "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES / 4) });
  const journalPack = Buffer.alloc(1024, 7);
  let writes = 0;
  let retainedGuard: (() => void) | undefined;
  const lostReply = probe.command(stateWorker, async (command, executeOptions, scope) => {
    const result = await scope.execute(command, executeOptions);
    if (command.type === "localWorkspace.mutate") {
      writes += 1;
      throw new Error("Synthetic local workspace reply lost after native commit");
    }
    return result;
  });
  const acknowledged = await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    retainedGuard = store.assertCurrent;
    const row = await store.update(
      { ...store.get()!, base_commit: "f".repeat(40) },
      {
        baseline_ref: "sha256:oversized",
        baseline_json: baseline,
        journal_json: "{}",
        journal_pack: journalPack,
        paused_runtimes_json: undefined,
      },
    );
    expect(store.get()).toEqual(row);
    return row;
  });
  lostReply.mockRestore();
  expect(writes).toBe(1);
  assert(retainedGuard);
  expect(retainedGuard).toThrow();
  const committed = await readLocalWorkspaceProjection(worktreeId, env);
  expect(acknowledged).toMatchObject({
    revision: 1,
    baseline_ref: "sha256:oversized",
    base_commit: "a".repeat(40),
    journal_json: "{}",
    paused_runtimes_json: null,
  });
  expect(acknowledged.baseline_json).toBe(baseline);
  // Keep the worker's plain byte-view shape without another main-thread copy.
  expect(acknowledged.journal_pack?.constructor).toBe(Uint8Array);
  expect(acknowledged.journal_pack?.buffer).toBe(journalPack.buffer);
  expect(acknowledged.journal_pack?.byteOffset).toBe(journalPack.byteOffset);
  expect(acknowledged.journal_pack?.byteLength).toBe(journalPack.byteLength);
  expect(committed).toEqual(acknowledged);
  expect(committed?.baseline_json).toBe(baseline);
});

it("queues an expanded checkpoint receipt behind another workspace write", async () => {
  const busyId = randomUUID();
  const checkpointId = randomUUID();
  const checkpoint = JSON.stringify({ syntheticRecords: "x".repeat(72 * 1024 * 1024) });
  await withLocalWorkspaceStore({ worktreeId: busyId, env }, async (busy) => {
    const initial = await busy.create(localWorkspaceProjectionFixture(busyId, root));
    await withLocalWorkspaceStore({ worktreeId: checkpointId, env }, async (store) => {
      const row = await store.create(localWorkspaceProjectionFixture(checkpointId, root));
      const held = Promise.withResolvers<void>();
      let publish: (() => boolean) | undefined;
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the worker.
      const emit = Worker.prototype.emit;
      const replies = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
        this: Worker,
        ...args: Parameters<Worker["emit"]>
      ) {
        const reply = args[1] as SqliteWorkerReply;
        if (args[0] === "message" && reply.ok && !reply.transfer && !reply.input) {
          const value = deserialize(reply.value);
          if (value?.worktree_id === busyId && value.revision === 1) {
            publish = () => {
              publish = undefined;
              return Reflect.apply(emit, this, args);
            };
            held.resolve();
            return true;
          }
        }
        return Reflect.apply(emit, this, args);
      });
      const pending = busy.update(initial, { paused_runtimes_json: "[]" });
      try {
        await held.promise;
        probe.command(stateWorker, (command, options, scope) => {
          const result = scope.execute(command, options);
          if (command.type === "localWorkspace.mutate") {
            // Release only after the real broker has admitted or refused the second write.
            replies.mockRestore();
            publish?.();
          }
          return result;
        });
        const accepted = await store.update(row, { checkpoint_json: checkpoint });
        expect(accepted.checkpoint_json).toBe(checkpoint);
        await pending;
      } finally {
        replies.mockRestore();
        publish?.();
        await pending;
      }
    });
  });
  expect((await readLocalWorkspaceProjection(checkpointId, env))?.checkpoint_json).toBe(checkpoint);
});

it("converts a v31 projection online without changing its root and recovers its saved checkpoint after restart", async () => {
  const worktreeId = randomUUID();
  const baseCommit = "a".repeat(40);
  const records = createLocalWorkspaceManifestTree([
    { path: "entry.txt", type: "file", mode: 0o644, size: 4, sha256: "a".repeat(64) },
  ]);
  const previousRoot = localWorkspaceManifestRootReference(records, baseCommit);
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
  const resultingRoot = localWorkspaceManifestRootReference(records, baseCommit);
  const checkpoint = {
    version: 1 as const,
    kind: "scan" as const,
    previousRoot,
    resultingRoot,
    ...changed,
    baseManifestRaw: serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit,
      entries: [legacyRows.find((record) => record.node.path === "entry.txt")!.node].filter(
        (node) => node.type !== "directory",
      ),
    }),
    baseManifestRef: "sha256:legacy-base",
    currentManifestRaw: serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit,
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

function sharingFixture() {
  const sharingRoot = dirs.make("openclaw-workspace-sharing-");
  const sharingEnv = { ...process.env, OPENCLAW_STATE_DIR: sharingRoot };
  const rawManifest = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit: "a".repeat(40),
    entries: [{ path: "src/file.txt", type: "file", mode: 0o644, size: 4, sha256: "b".repeat(64) }],
    directories: ["src"],
  });
  const document = {
    rawManifest,
    manifestRef: `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`,
    buildCacheInputs: [],
  };
  const create = async () => {
    const worktreeId = randomUUID();
    await withLocalWorkspaceStore({ worktreeId, env: sharingEnv }, async (store) => {
      const row = await store.create(localWorkspaceProjectionFixture(worktreeId, sharingRoot));
      await store.update(row, {}, undefined, document);
    });
    return worktreeId;
  };
  return { sharingEnv, document, create };
}

it("inserts zero manifest packs when replacing a baseline with a known tree", async () => {
  const { sharingEnv, document, create } = sharingFixture();
  const worktreeId = await create();
  const database = openOpenClawStateDatabase({ env: sharingEnv });
  const table = "local_workspace_tree_packs";
  database.db.exec(`CREATE TABLE manifest_insert_evidence (inserted INTEGER NOT NULL) STRICT;
    CREATE TRIGGER count_manifest_inserts AFTER INSERT ON ${table}
    BEGIN INSERT INTO manifest_insert_evidence VALUES (1); END;`);
  await withLocalWorkspaceStore({ worktreeId, env: sharingEnv }, async (store) => {
    await store.update(store.get()!, {}, undefined, document);
    const materialized = await store.manifest(store.get()!, { kind: "materialize" });
    expect(materialized).toMatchObject({ kind: "materialize", rawManifest: document.rawManifest });
  });
  expect(
    Number(
      database.db.prepare("SELECT count(*) AS count FROM manifest_insert_evidence").get()!.count,
    ),
  ).toBe(0);
});
