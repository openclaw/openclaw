import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
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

it("distinguishes committed deletion from unknown or mismatched row coverage", () => {
  const worktreeId = randomUUID();
  expect(readLocalWorkspaceCommit(null, worktreeId)).toBeUndefined();
  expect(() => readLocalWorkspaceCommit(undefined, worktreeId)).toThrow("coverage is incomplete");
  expect(() =>
    readLocalWorkspaceCommit(
      { ...localWorkspaceProjectionFixture(randomUUID(), root), revision: 0 },
      worktreeId,
    ),
  ).toThrow("committed row is invalid");
});

it("keeps mutation preconditions small without trimming committed payloads", () => {
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
  mutateProjection(database, worktreeId, { kind: "create", row: initial });
  const reads = trackSqliteStatementExecutions(database, ["precondition"], (sql) =>
    /^select\b/i.test(sql) && sql.includes("local_workspace_projections") ? "precondition" : null,
  );
  cleanup.defer(reads.restore);
  expect(() => mutateProjection(database, worktreeId, { kind: "create", row: initial })).toThrow(
    "Local workspace binding already exists",
  );
  const updated = mutateProjection(database, worktreeId, {
    kind: "update",
    revision: 0,
    patch: { paused_runtimes_json: "[]" },
  });
  assert(updated?.journal_pack);
  expect(updated).toMatchObject({ revision: 1, paused_runtimes_json: "[]" });
  expect(updated.baseline_json).toBe(baseline);
  expect(Buffer.from(updated.journal_pack).equals(journalPack)).toBe(true);
  expect(() => mutateProjection(database, worktreeId, { kind: "delete", revision: 1 })).toThrow(
    "Local workspace has unsettled edits",
  );
  mutateProjection(database, worktreeId, {
    kind: "update",
    revision: 1,
    patch: { journal_json: "", journal_pack: new Uint8Array(), pending_ref: "" },
  });
  mutateProjection(database, worktreeId, { kind: "delete", revision: 2 });
  expect(readProjectionInDatabase(database, worktreeId)).toBeUndefined();
  expect(reads.textBytes.precondition + reads.blobBytes.precondition).toBeLessThan(1024);
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

it("refuses unknown recovery after an oversized committed row loses its reply", async () => {
  const worktreeId = randomUUID();
  await withLocalWorkspaceStore({ worktreeId, env }, (store) =>
    store.create(localWorkspaceProjectionFixture(worktreeId, root)),
  );
  const baseline = JSON.stringify({ synthetic: "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES / 4) });
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
  await expect(
    withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
      retainedGuard = store.assertCurrent;
      await store.update(store.get()!, {
        baseline_ref: "sha256:oversized",
        baseline_json: baseline,
      });
    }),
  ).rejects.toThrow("Local workspace commit coverage is incomplete");
  lostReply.mockRestore();
  expect(writes).toBe(1);
  assert(retainedGuard);
  expect(retainedGuard).toThrow();
  const committed = await readLocalWorkspaceProjection(worktreeId, env);
  expect(committed).toMatchObject({ revision: 1, baseline_ref: "sha256:oversized" });
  expect(committed?.baseline_json).toBe(baseline);
});
