import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
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
import {
  type SqliteWorkerReply,
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
} from "../../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
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
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
  updateLocalWorkspaceManifestTree,
} from "./local-workspace-manifest-tree.js";
import { readLocalWorkspaceCommit } from "./local-workspace-publication.js";
import { withLocalWorkspaceStore, type LocalWorkspaceStore } from "./local-workspace-store.js";
import { mutateLocalWorkspaceProjection as mutateProjection } from "./local-workspace-store.kernel.js";
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

const fixture = (id: string) => localWorkspaceProjectionFixture(id, root);
const withStore = <T>(id: string, run: (store: LocalWorkspaceStore) => Promise<T>) =>
  withLocalWorkspaceStore({ worktreeId: id, env }, run);
const create = (id: string) => withStore(id, (store) => store.create(fixture(id)));
const read = (id: string) => readLocalWorkspaceProjection(id, env);
function nodeRows(id: string) {
  return openOpenClawStateDatabase({ env })
    .db.prepare(
      "SELECT path, node_json FROM local_workspace_manifest_nodes WHERE worktree_id = ? ORDER BY path",
    )
    .all(id);
}
function loseMutationReplies() {
  let writes = 0;
  const mock = probe.command(stateWorker, async (command, options, scope) => {
    const reply = await scope.execute(command, options);
    if (command.type === "localWorkspace.mutate") {
      writes++;
      throw new Error("Synthetic local workspace reply lost after native commit");
    }
    return reply;
  });
  return { count: () => writes, restore: () => mock.mockRestore() };
}
async function materialize(store: LocalWorkspaceStore, row = store.get()!) {
  const value = await store.manifest(row, { kind: "materialize" });
  assert(value.kind === "materialize");
  return JSON.parse(value.rawManifest);
}
function interruptHeader(id: string, trigger: string, message: string) {
  const { db } = openOpenClawStateDatabase({ env });
  db.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON local_workspace_projections
    WHEN NEW.worktree_id = '${id}' BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
  return () => db.exec(`DROP TRIGGER ${trigger};`);
}

it("distinguishes committed deletion from unknown or mismatched mutation coverage", () => {
  const worktreeId = randomUUID();
  const previous = { ...fixture(worktreeId), revision: 0 };
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

it("bounds mutation preconditions and receipts independently of stored payloads", () => {
  using cleanup = new DisposableStack();
  const database = new DatabaseSync(":memory:");
  cleanup.defer(() => database.close());
  const id = randomUUID();
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
  mutateProjection(database, id, {
    kind: "create",
    row: {
      ...fixture(id),
      baseline_json: JSON.stringify({ synthetic: "x".repeat(3 * 1024 * 1024) }),
      journal_json: "{}",
      journal_pack: new Uint8Array(3 * 1024 * 1024).fill(7),
    },
  });
  expect(() => mutateProjection(database, id, { kind: "delete", revision: 0 })).toThrow(
    "unsettled edits",
  );
  mutateProjection(database, id, {
    kind: "update",
    revision: 0,
    patch: { paused_runtimes_json: "[]" },
  });
  for (const kind of ["precondition", "receipt"] as const) {
    expect(reads.textBytes[kind] + reads.blobBytes[kind]).toBeLessThan(1024);
  }
});

it("preserves the acknowledged row when a stale revision conflicts", async () => {
  const worktreeId = randomUUID();
  let committed: Awaited<ReturnType<typeof readLocalWorkspaceProjection>>;
  let retainedGuard: (() => void) | undefined;
  await expect(
    withStore(worktreeId, async (store) => {
      retainedGuard = store.assertCurrent;
      const initial = await store.create(fixture(worktreeId));
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
  expect(await read(worktreeId)).toEqual(committed);
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
      const row = await store.create(fixture(worktreeId));
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

it("accepts manifest nodes and checkpoint headers atomically and preserves them on rollback", async () => {
  const worktreeId = randomUUID();
  const records = createLocalWorkspaceManifestTree([
    { path: "old.txt", type: "file", mode: 0o644, size: 3, sha256: "a".repeat(64) },
    { path: "kept.txt", type: "file", mode: 0o644, size: 4, sha256: "b".repeat(64) },
  ]);
  const acceptedRoot = localWorkspaceManifestRootReference(records, null);
  await withStore(worktreeId, async (store) => {
    const row = await store.create({
      ...fixture(worktreeId),
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
  const acceptedNodes = nodeRows(worktreeId);
  expect(acceptedNodes.map((row) => row.path)).toEqual(["", "kept.txt", "old.txt"]);
  const accepted = await read(worktreeId);
  expect(accepted).toMatchObject({
    baseline_ref: acceptedRoot,
    baseline_json: null,
    checkpoint_json: "accepted receipt",
    revision: 1,
  });
  const next = updateLocalWorkspaceManifestTree(records, [{ path: "old.txt" }]);
  const nextRoot = localWorkspaceManifestRootReference(records, null);
  const restore = interruptHeader(
    worktreeId,
    "refuse_manifest_header",
    "synthetic manifest acceptance interruption",
  );
  try {
    await expect(
      withStore(worktreeId, (store) =>
        store.update(store.get()!, { checkpoint_json: "next receipt" }, undefined, {
          previousRoot: acceptedRoot,
          resultingRoot: nextRoot,
          ...next,
        }),
      ),
    ).rejects.toThrow("synthetic manifest acceptance interruption");
    expect(nodeRows(worktreeId)).toEqual(acceptedNodes);
    expect(await read(worktreeId)).toEqual(accepted);
  } finally {
    restore();
  }
  await expect(
    withStore(worktreeId, (store) =>
      store.update(store.get()!, {}, undefined, {
        previousRoot: "sha256:stale",
        resultingRoot: nextRoot,
        ...next,
      }),
    ),
  ).rejects.toThrow("manifest baseline changed");
  expect(nodeRows(worktreeId)).toEqual(acceptedNodes);
  await withStore(worktreeId, async (store) => {
    const row = await store.update(store.get()!, { checkpoint_json: "next receipt" }, undefined, {
      previousRoot: acceptedRoot,
      resultingRoot: nextRoot,
      ...next,
    });
    expect(row).toMatchObject({ baseline_ref: nextRoot, checkpoint_json: "next receipt" });
  });
  expect(nodeRows(worktreeId).map((row) => row.path)).toEqual(["", "kept.txt"]);
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
  const initial = await withStore(worktreeId, (store) =>
    store.create({
      ...fixture(worktreeId),
      baseline_json: rawManifest,
      baseline_ref: manifestRef,
    }),
  );
  const nodePaths = () => nodeRows(worktreeId).map((row) => row.path);
  const replace = () =>
    withStore(worktreeId, (store) =>
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
  const restore = interruptHeader(
    worktreeId,
    "refuse_prepared_baseline",
    "synthetic prepared baseline interruption",
  );
  try {
    await expect(replace()).rejects.toThrow("synthetic prepared baseline interruption");
    expect(await read(worktreeId)).toEqual(initial);
    expect(nodePaths()).toEqual([]);
  } finally {
    restore();
  }
  const lostReply = loseMutationReplies();
  const acknowledged = await replace();
  lostReply.restore();
  expect(lostReply.count()).toBe(1);
  expect(acknowledged).toMatchObject({
    revision: initial.revision + 1,
    baseline_json: null,
    pending_ref: "refs/openclaw/results/accepted",
  });
  expect(acknowledged.baseline_ref).not.toBe(manifestRef);
  expect(await read(worktreeId)).toEqual(acknowledged);
  expect(nodePaths()).toEqual(["", "src", "src/next.txt"]);
  await withStore(worktreeId, async (store) => {
    expect(await materialize(store)).toMatchObject(JSON.parse(rawManifest));
  });
});

it("rejects stale worker-prepared observations without consuming edits or replaying metadata", async () => {
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
  const initial = await withStore(worktreeId, async (store) => {
    const row = await store.create({
      ...fixture(worktreeId),
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
  const initialNodes = nodeRows(worktreeId);
  const pending = {
    pending_ref: "refs/openclaw/results/retained",
    checkpoint_json: "retained checkpoint receipt",
  };
  await expect(
    withStore(worktreeId, async (store) => {
      const scan = await store.manifest(store.get()!, action);
      assert(scan.kind === "scan");
      // Include every returned array, not just the current records field.
      const expanded = Object.values(scan)
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .filter((value) => value && typeof value === "object" && "node" in value);
      expect(expanded.length).toBeLessThan(unchangedPaths.length);
      assert(scan.observation);
      expect(scan.resultingRoot).not.toBe(initial.baseline_ref);
      await store.update(store.get()!, pending);
      await store.accept(scan.observation);
    }),
  ).rejects.toThrow("Local workspace binding changed");
  expect(nodeRows(worktreeId)).toEqual(initialNodes);
  expect(await read(worktreeId)).toMatchObject({
    ...pending,
    revision: initial.revision + 1,
    baseline_ref: initial.baseline_ref,
    source_paths_json: initial.source_paths_json,
  });
  await withStore(worktreeId, async (store) => {
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
    const persisted = nodeRows(worktreeId);
    expect(persisted).not.toEqual(initialNodes);
    expect(persisted.map((row) => row.path)).toEqual(initialNodes.map((row) => row.path));
    expect(
      persisted.map((row) => {
        assert(typeof row.node_json === "string");
        return JSON.parse(row.node_json);
      }),
    ).toContainEqual(
      expect.objectContaining({
        canonicalIdentity: expect.any(String),
        node: expect.objectContaining({ sha256: hash("before") }),
      }),
    );
    expect(await materialize(store, observed)).toEqual(JSON.parse(rawManifest));
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
              const initial = await store.create(fixture(worktreeId));
              aboutToUpdate = true;
              await store.update(initial, { pending_ref: "refs/openclaw/results/refused" });
            },
          );
        },
      ),
    ).rejects.toThrow(/lease/iu);
    expect(revoked).toBe(true);
    expect(await read(worktreeId)).toMatchObject({
      revision: 0,
      pending_ref: null,
    });
  } finally {
    database.db
      .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
      .run(scope, worktreeId);
  }
});

it.each([false, true])(
  "adopts committed facts after reply loss (oversized: %s)",
  async (oversized) => {
    const worktreeId = randomUUID();
    await create(worktreeId);
    await expect(
      withStore(worktreeId, (store) => store.create(fixture(worktreeId))),
    ).rejects.toThrow("Local workspace binding already exists");
    const baseline = JSON.stringify({ synthetic: "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES / 4) });
    const journalPack = new Uint8Array(1024).fill(7);
    const pendingRef = "refs/openclaw/results/accepted";
    const patch = oversized
      ? {
          baseline_ref: "sha256:oversized",
          baseline_json: baseline,
          journal_json: "{}",
          journal_pack: journalPack,
          paused_runtimes_json: undefined,
        }
      : { pending_ref: pendingRef };
    let retainedGuard: (() => void) | undefined;
    const lostReply = loseMutationReplies();
    const acknowledged = await withStore(worktreeId, async (store) => {
      retainedGuard = store.assertCurrent;
      const row = await store.update({ ...store.get()!, base_commit: "f".repeat(40) }, patch);
      expect(store.get()).toEqual(row);
      return row;
    });
    expect(lostReply.count()).toBe(1);
    assert(retainedGuard);
    expect(retainedGuard).toThrow();
    expect(acknowledged).toMatchObject({ revision: 1, base_commit: "a".repeat(40) });
    expect(await read(worktreeId)).toEqual(acknowledged);
    if (oversized) {
      lostReply.restore();
      expect(acknowledged).toMatchObject({
        baseline_ref: "sha256:oversized",
        journal_json: "{}",
        paused_runtimes_json: null,
        baseline_json: baseline,
      });
      expect(acknowledged.journal_pack).toEqual(journalPack);
    } else {
      expect(acknowledged.pending_ref).toBe(pendingRef);
      await withStore(worktreeId, async (store) => {
        expect(store.get()).toEqual(acknowledged);
        await expect(store.delete(store.get()!)).rejects.toThrow("unsettled edits");
      });
      await withStore(worktreeId, async (store) => {
        const cleared = await store.update(store.get()!, { pending_ref: null });
        await store.delete(cleared);
        expect(store.get()).toBeUndefined();
      });
      lostReply.restore();
      expect(lostReply.count()).toBe(3);
      expect(await read(worktreeId)).toBeUndefined();
    }
  },
);

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
