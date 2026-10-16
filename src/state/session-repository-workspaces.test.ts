import { renameSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { ensureRepositoryWorkspacePendingResultSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import * as stateWorker from "./openclaw-state-worker-store.js";
import { createSessionRepositoryWorkspaceStore } from "./session-repository-workspaces.js";
import {
  bindSessionRepositoryWorkspaceBaseInDatabase,
  createSessionRepositoryWorkspaceInDatabase,
  deleteSessionRepositoryWorkspaceInDatabase,
} from "./session-repository-workspaces.kernel.js";

const roots: string[] = [];
const subscriptions: (() => void)[] = [];
const assertCurrent = () => {};
const source = {
  agentId: "main",
  sessionKey: "agent:main:repository",
  url: "https://github.com/example/project.git",
  requestedRef: "main",
  assertCurrent,
};
const baseCommit = "a".repeat(40);
const baseManifestHash = `sha256:${"b".repeat(64)}`;

afterEach(async () => {
  for (const unsubscribe of subscriptions.splice(0)) {
    unsubscribe();
  }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await closeOpenClawStateDatabaseByPathAsync(path.join(root, "openclaw.sqlite"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("rolls back a revoked native commit without publishing changed repository facts", async () => {
  const { store } = await fixture();
  const initial = await store.create(source);
  const prepared = await store.prepare(initial.workspaceId);
  let current = true;
  let commitRequested = false;
  const changed = vi.fn();
  const unsubscribe = sessionChanges.subscribe(changed);
  probe.admission(operationAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      commitRequested = true;
      current = false;
    }
    admit(request, grant);
  });
  try {
    await expect(
      store.bindBase({
        workspaceId: initial.workspaceId,
        expectedRevision: initial.revision,
        baseCommit,
        baseManifestHash,
        assertCurrent: () => {
          if (!current) {
            throw new Error("repository owner revoked");
          }
        },
      }),
    ).rejects.toThrow("repository owner revoked");
    expect(commitRequested).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(prepared.current()).toEqual(initial);
    expect(await store.get(initial.workspaceId)).toEqual(initial);
  } finally {
    unsubscribe();
  }
});

it("returns the committed workspace identity when ordinary result delivery fails", async () => {
  const { store } = await fixture();
  const execute = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
    async (...args) => {
      await execute(...args);
      throw new Error("result delivery failed after native settlement");
    },
  );
  const changed = vi.fn();
  const unsubscribe = sessionChanges.subscribe(changed);
  try {
    const created = await store.create(source);
    expect(await store.find(source)).toEqual(created);
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      agentId: source.agentId,
      sessionKey: source.sessionKey,
    });
    await store.delete({ workspaceId: created.workspaceId, assertCurrent });
    expect(await store.get(created.workspaceId)).toBeUndefined();
  } finally {
    unsubscribe();
  }
});

it("publishes native base changes and deletion before returning without exposing rollback", async () => {
  const { database, store } = await fixture();
  const initial = await store.create(source);
  const prepared = await store.prepare(initial.workspaceId);
  const bind = () =>
    bindSessionRepositoryWorkspaceBaseInDatabase(
      database.db,
      {
        workspaceId: initial.workspaceId,
        expectedRevision: initial.revision,
        baseCommit,
        baseManifestHash,
      },
      2,
    );
  expect(() =>
    runOpenClawStateWriteTransaction(
      () => {
        bind();
        expect(prepared.current()).toEqual(initial);
        throw new Error("rollback workspace base");
      },
      { database },
    ),
  ).toThrow("rollback workspace base");
  expect(prepared.current()).toEqual(initial);
  runOpenClawStateWriteTransaction(bind, { database });
  expect(prepared.current()).toMatchObject({ baseCommit, baseManifestHash, revision: 1 });
  runOpenClawStateWriteTransaction(
    () => deleteSessionRepositoryWorkspaceInDatabase(database.db, initial.workspaceId),
    { database },
  );
  expect(prepared.current()).toBeUndefined();
});

it("fences detached absence while its removal settles", async () => {
  const { store } = await fixture();
  const workspaceId = "00000000-0000-4000-8000-000000000000";
  const absent = await store.prepare(workspaceId);
  expect(absent.current()).toBeUndefined();
  let refused = false;
  const admission = probe.admission(operationAdmission, (request, grant, admit) => {
    if (request.stage !== "commit") {
      admit(request, grant);
      return;
    }
    admit(request, () => {
      expect(() => absent.current()).toThrow("mutation has not settled");
      refused = true;
      throw new Error("workspace successor refused before commit");
    });
  });
  await expect(store.delete({ workspaceId, assertCurrent })).rejects.toThrow(
    "workspace successor refused before commit",
  );
  admission.mockRestore();
  expect(refused).toBe(true);
  expect(absent.current()).toBeUndefined();
  expect((await store.prepare(workspaceId)).current()).toBeUndefined();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repository-owner-"));
  roots.push(root);
  const database = openOpenClawStateDatabase({ path: path.join(root, "openclaw.sqlite") });
  return { database, store: createSessionRepositoryWorkspaceStore({ path: database.path }) };
}

function observeChanges() {
  const changed = vi.fn();
  subscriptions.push(sessionChanges.subscribe(changed));
  return changed;
}

it("captures a lazy store location and retains it across environment changes and reopen", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async (state) => {
    const firstPath = resolveOpenClawStateSqlitePath();
    const secondPath = resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: state.statePath("second"),
    });
    try {
      const store = createSessionRepositoryWorkspaceStore();
      expect(store.path).toBe(firstPath);
      const workspaceId = "00000000-0000-4000-8000-000000000000";
      expect(store.artifactPath(workspaceId)).toBe(
        path.join(path.dirname(firstPath), "repository-workspaces", `${workspaceId}.git`),
      );
      expect.soft(isOpenClawStateDatabaseOpen(firstPath)).toBe(false);
      await expect.soft(fs.stat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });

      vi.stubEnv("OPENCLAW_STATE_DIR", state.statePath("second"));
      const initial = await store.create(source);
      expect(await store.get(initial.workspaceId)).toEqual(initial);
      expect(isOpenClawStateDatabaseOpen(firstPath)).toBe(false);
      await closeOpenClawStateDatabaseByPathAsync(firstPath);
      expect(await store.find(source)).toEqual(initial);
      expect(isOpenClawStateDatabaseOpen(secondPath)).toBe(false);
      await expect(fs.stat(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(firstPath);
      await closeOpenClawStateDatabaseByPathAsync(secondPath);
      vi.unstubAllEnvs();
    }
  });
});

it("retries rolled-back first-use pending owner DDL and preserves the committed column on reopen", async () => {
  const { database } = await fixture();
  database.db.exec(
    "ALTER TABLE worker_workspace_pending_results DROP COLUMN repository_workspace_id",
  );
  const hasPendingRepositoryColumn = (db = database.db) =>
    tableHasColumn(db, "worker_workspace_pending_results", "repository_workspace_id");
  expect(hasPendingRepositoryColumn()).toBe(false);
  expect(() =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        ensureRepositoryWorkspacePendingResultSchema(db);
        // A later first-use writer must not cache this uncommitted column.
        ensureRepositoryWorkspacePendingResultSchema(db);
        expect(hasPendingRepositoryColumn(db)).toBe(true);
        throw new Error("pending result rolled back");
      },
      { database },
    ),
  ).toThrow("pending result rolled back");
  expect(hasPendingRepositoryColumn()).toBe(false);
  runOpenClawStateWriteTransaction(({ db }) => ensureRepositoryWorkspacePendingResultSchema(db), {
    database,
  });
  expect(hasPendingRepositoryColumn()).toBe(true);
  await closeOpenClawStateDatabaseByPathAsync(database.path);
  expect(hasPendingRepositoryColumn(openOpenClawStateDatabase({ path: database.path }).db)).toBe(
    true,
  );
});

it("creates one stable logical-session owner without widening replayed setup intent", async () => {
  const { database, store } = await fixture();
  const changed = observeChanges();
  expect(await store.find(source)).toBeUndefined();
  expect(tableExists(database.db, "session_repository_workspaces")).toBe(false);
  expect(() =>
    runOpenClawStateWriteTransaction(
      () => {
        createSessionRepositoryWorkspaceInDatabase(database.db, source, Date.now());
        expect(changed).not.toHaveBeenCalled();
        throw new Error("session creation rolled back");
      },
      { database },
    ),
  ).toThrow("session creation rolled back");
  expect(changed).not.toHaveBeenCalled();
  expect(tableExists(database.db, "session_repository_workspaces")).toBe(false);
  const initial = await store.create(source);
  expect(await store.create({ ...source, runSetupScript: true })).toEqual(initial);
  expect(initial.runSetupScript).toBe(false);
  expect(initial.branch).toBe(`openclaw/${initial.workspaceId}`);
  await expect(store.create({ ...source, requestedRef: "other" })).rejects.toThrow(
    "different repository",
  );
  expect((await store.create({ ...source, agentId: "other" })).workspaceId).not.toBe(
    initial.workspaceId,
  );
});

it("publishes committed workspace revisions, rejects stale checkpoints, and retires prepared guards on close", async () => {
  const { database, store } = await fixture();
  const changed = observeChanges();
  const initial = await store.create(source);
  expect(changed).toHaveBeenCalledExactlyOnceWith({
    agentId: source.agentId,
    sessionKey: source.sessionKey,
  });
  const prepared = await store.prepare(initial.workspaceId);
  expect(prepared.current()).toEqual(initial);
  const bound = await store.bindBase({
    workspaceId: initial.workspaceId,
    expectedRevision: initial.revision,
    baseCommit,
    baseManifestHash,
    assertCurrent: () => expect(prepared.current()).toEqual(initial),
  });
  expect(prepared.current()).toEqual(bound);
  const checkpoint = {
    workspaceId: bound.workspaceId,
    expectedRevision: bound.revision,
    checkpointRef: "refs/openclaw/worker-results/turn-1",
    manifestHash: `sha256:${"c".repeat(64)}`,
    assertCurrent,
  };
  await expect(
    store.acceptCheckpoint({
      ...checkpoint,
      assertCurrent: () => {
        throw new Error("claim closed");
      },
    }),
  ).rejects.toThrow("claim closed");
  expect(await store.get(bound.workspaceId)).toEqual(bound);
  await expect(
    store.bindBase({
      workspaceId: bound.workspaceId,
      expectedRevision: bound.revision,
      baseCommit: "d".repeat(40),
      assertCurrent,
    }),
  ).rejects.toThrow("base changed");
  const accepted = await store.acceptCheckpoint(checkpoint);
  await expect(store.acceptCheckpoint(checkpoint)).rejects.toThrow("revision changed");
  expect(accepted).toMatchObject({
    baseCommit,
    baseManifestHash,
    checkpointRef: checkpoint.checkpointRef,
    manifestHash: checkpoint.manifestHash,
    revision: bound.revision + 1,
  });
  await closeOpenClawStateDatabaseByPathAsync(database.path);
  expect(() => prepared.current()).toThrow();
  expect(await store.get(initial.workspaceId)).toEqual(accepted);
  await store.delete({ workspaceId: initial.workspaceId, assertCurrent });
  expect(changed).toHaveBeenCalledTimes(4);
  expect(
    changed.mock.calls.every(
      ([change]) => change.agentId === source.agentId && change.sessionKey === source.sessionKey,
    ),
  ).toBe(true);
});

it("reopens an owner and finishes only its artifact cleanup while database close waits", async () => {
  const { database, store: original } = await fixture();
  const workspace = await original.create(source);
  const sibling = await original.create({ ...source, sessionKey: "agent:main:sibling" });
  await fs.mkdir(original.artifactPath(sibling.workspaceId), { recursive: true });
  await closeOpenClawStateDatabaseByPathAsync(database.path);
  const store = createSessionRepositoryWorkspaceStore({ path: database.path });
  expect(await store.find(source)).toEqual(workspace);
  const reopened = openOpenClawStateDatabase({ path: database.path });
  const artifact = store.artifactPath(workspace.workspaceId);
  await fs.mkdir(artifact, { recursive: true });
  const removing = createDeferredCore();
  const releaseRemoval = createDeferredCore();
  const remove = fs.rm;
  const removal = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === artifact) {
      removing.resolve();
      await releaseRemoval.promise;
    }
    await remove(target, options);
  });
  let closing: ReturnType<typeof closeOpenClawStateDatabaseByPathAsync> | undefined;
  let closed = false;
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === source.sessionKey) {
      closing = closeOpenClawStateDatabaseByPathAsync(database.path);
      void closing.then(() => {
        closed = true;
      });
    }
  });
  const outcome = store.delete({ workspaceId: workspace.workspaceId, assertCurrent }).then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
  try {
    expect(
      await Promise.race([removing.promise.then(() => "removing"), outcome.then(() => "settled")]),
    ).toBe("removing");
    expect(closing).toBeDefined();
    expect(closed).toBe(false);
    expect(reopened.db.isOpen).toBe(true);
    releaseRemoval.resolve();
    expect(await outcome).toEqual({ ok: true });
    await closing;
    expect(closed).toBe(true);
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.get(workspace.workspaceId)).toBeUndefined();
    expect(await store.find(source)).toBeUndefined();
    expect(await store.get(sibling.workspaceId)).toEqual(sibling);
    expect((await fs.stat(store.artifactPath(sibling.workspaceId))).isDirectory()).toBe(true);
  } finally {
    releaseRemoval.resolve();
    await outcome;
    unsubscribe();
    await closing;
    removal.mockRestore();
  }
});

// Open SQLite files prevent this directory-swap scenario on Windows.
it.runIf(process.platform !== "win32")(
  "refuses artifact cleanup against a replaced physical database after committed deletion",
  async () => {
    const { database, store } = await fixture();
    const workspace = await store.create(source);
    await fs.mkdir(store.artifactPath(workspace.workspaceId), { recursive: true });
    const replacement = await fixture();
    const successor = await replacement.store.create({
      ...source,
      sessionKey: "agent:main:replacement",
    });
    await fs.mkdir(replacement.store.artifactPath(workspace.workspaceId), { recursive: true });
    await closeOpenClawStateDatabaseByPathAsync(replacement.database.path);
    const replacementBytes = await fs.readFile(replacement.database.path);
    const root = path.dirname(database.path);
    const replacementRoot = path.dirname(replacement.database.path);
    const retired = `${root}-retired`;
    roots.push(retired);
    let originalMoved = false;
    let replacementInstalled = false;
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === source.sessionKey) {
        renameSync(root, retired);
        originalMoved = true;
        renameSync(replacementRoot, root);
        replacementInstalled = true;
      }
    });
    try {
      const failure = await store
        .delete({ workspaceId: workspace.workspaceId, assertCurrent })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(replacementInstalled).toBe(true);
      expect.soft(failure).toMatchObject({
        message: expect.stringContaining("SQLite database file identity changed"),
      });
      await expect.soft(fs.stat(store.artifactPath(workspace.workspaceId))).resolves.toBeDefined();
      expect(await fs.readFile(database.path)).toEqual(replacementBytes);
    } finally {
      unsubscribe();
      if (replacementInstalled) {
        renameSync(root, replacementRoot);
      }
      if (originalMoved) {
        renameSync(retired, root);
      }
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
    expect(await store.get(workspace.workspaceId)).toBeUndefined();
    expect(await replacement.store.get(successor.workspaceId)).toEqual(successor);
  },
);
