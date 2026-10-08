import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admissions from "../../infra/sqlite-worker-operation-admission.js";
import { removeSessionWorktree } from "../../sessions/session-worktree-lifecycle.js";
import { withExistingOpenClawStateSchema } from "../../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import {
  observeMainThreadReads,
  observeMainThreadSql,
} from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  SessionWorktreeLifecycleError,
  SessionWorktreeSourceChangedError,
  WorktreeRemovalLockError,
} from "./errors.js";
import { insertRegistryWorktreeProvisionedChunk } from "./provisioned-snapshot.test-support.js";
import {
  captureWorktreeRegistryReadGuard,
  prepareWorktreeRegistryGuard,
  readLiveRegistryWorktreeByOwner,
  readRegistryWorktree,
} from "./registry-read.js";
import {
  abortWorktreeRemovalRow,
  claimWorktreeRemovalRow,
  clearRegistryWorktreeProvisionedChunks,
  finalizeWorktreeRemovalRows,
  insertRegistryWorktree,
  WorktreeRemovalContentionError,
  updateRegistryWorktree,
} from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { withWorktreeRunEnd, prepareWorktreeRunEndClose } from "./run-end-lifecycle.js";
import { admitWorktreeRunLeaseRowAsync } from "./run-lease-store.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const initializeRepository = useManagedWorktreeTestRepository();
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it("joins schema-wrapped work and keeps sibling and successor Gateway lifetimes open", async () => {
  const { env, database } = await fixture();
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const first = withExistingOpenClawStateSchema({ path: database.path }, () =>
    prepareWorktreeRunEndClose(),
  );
  const sibling = prepareWorktreeRunEndClose();
  await withWorktreeRunEnd(env, async () => {
    let queued = Promise.resolve();
    withExistingOpenClawStateSchema({ path: database.path }, () => {
      queued = clearRegistryWorktreeProvisionedChunks(env, "synthetic");
    });
    await expect(queued).rejects.toThrow("schema admission has ended");
  });
  await withExistingOpenClawStateSchema({ path: database.path }, () =>
    withWorktreeRunEnd(env, () => clearRegistryWorktreeProvisionedChunks(env, "synthetic")),
  );
  first.beginClose();
  await first.drain();
  await clearRegistryWorktreeProvisionedChunks(env, "synthetic");
  sibling.beginClose();
  const successor = prepareWorktreeRunEndClose();
  await sibling.drain();
  await clearRegistryWorktreeProvisionedChunks(env, "synthetic");
  successor.beginClose();
  await successor.drain();
  await expect(clearRegistryWorktreeProvisionedChunks(env, "synthetic")).rejects.toThrow(
    "run-end admission is closed",
  );
});

async function fixture() {
  const root = dirs.make("worktree-run-end-worker-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const database = openOpenClawStateDatabase({ env });
  await insertRegistryWorktree(env, {
    id: "synthetic",
    name: "synthetic",
    repoFingerprint: "0123456789abcdef",
    repoRoot: root,
    path: root,
    branch: "synthetic",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: "agent:main:synthetic",
    createdAt: 1,
    lastActiveAt: 1,
  });
  const claim = {
    worktreeId: "synthetic",
    token: "first",
    pid: process.pid,
    startTime: null,
    now: 1,
  };
  return { env, database, claim };
}

it("retains SQL-free effect authority across unrelated writes and revokes pending owner changes", async () => {
  const { env, claim } = await fixture();
  const context = captureOpenClawStateWorkerContext({ env });
  const acceptSource = captureWorktreeRegistryReadGuard(context, "source-owner");
  const acceptBinding = captureWorktreeRegistryReadGuard(context, "binding");
  const acceptPublication = captureWorktreeRegistryReadGuard(context, "publication");
  const record = (await readLiveRegistryWorktreeByOwner(
    context,
    "session",
    "agent:main:synthetic",
  ))!;
  const assertSource = acceptSource(record);
  const assertBinding = acceptBinding(record);
  const assertPublication = acceptPublication(record);
  const assertExactOwner = await prepareWorktreeRegistryGuard(context, {
    predicates: [{ kind: "exact-owner", record }],
  });
  const sql = observeMainThreadSql();
  try {
    await clearRegistryWorktreeProvisionedChunks(env, record.id);
    await updateRegistryWorktree(env, record.id, {
      snapshotRef: "refs/openclaw/snapshots/synthetic",
    });
    await insertRegistryWorktree(env, { ...record, id: "child", ownerId: "agent:main:child" });
    assertSource();
    assertExactOwner();

    await updateRegistryWorktree(
      env,
      record.id,
      {
        repositoryIdentity: { repoRoot: record.repoRoot, repoFingerprint: "normalized" },
      },
      {
        workerAuthority: {
          assertCurrent: assertExactOwner,
          predicates: [{ kind: "binding", record }],
        },
      },
    );
    assertExactOwner();
    assertSource();
    expect(assertBinding).toThrow("owner or binding changed");
    expect(assertPublication).toThrow(SessionWorktreeSourceChangedError);

    const createAdmission = admissions.createSqliteWorkerOperationAdmission;
    let pendingChecks = 0;
    const inspectCommit = vi
      .spyOn(admissions, "createSqliteWorkerOperationAdmission")
      .mockImplementation((handler, ...options) =>
        createAdmission(
          (request, grant) => {
            if (request.stage === "commit") {
              pendingChecks += 1;
              expect(assertSource).toThrow(SessionWorktreeSourceChangedError);
              expect(assertExactOwner).toThrow("owner or lifecycle changed");
            }
            return handler(request, grant);
          },
          ...options,
        ),
      );
    try {
      await updateRegistryWorktree(
        env,
        claim.worktreeId,
        {
          repositoryIdentity: { repoRoot: record.repoRoot, repoFingerprint: "rebound" },
        },
        { assertCurrent: assertExactOwner },
      );
    } finally {
      inspectCommit.mockRestore();
    }
    expect(pendingChecks).toBeGreaterThan(0);
    expect(assertExactOwner).toThrow("owner or lifecycle changed");

    const acceptReplacement = captureWorktreeRegistryReadGuard(context, "source-owner");
    const current = (await readRegistryWorktree(context, record.id))!;
    const assertSelected = acceptReplacement(current);
    await insertRegistryWorktree(env, { ...current, id: "replacement", createdAt: 2 });
    expect(assertSelected).toThrow(SessionWorktreeSourceChangedError);
    sql.expectIdle();

    const acceptCurrent = captureWorktreeRegistryReadGuard(context, "source-owner");
    const assertCurrent = acceptCurrent(
      await readLiveRegistryWorktreeByOwner(context, "session", record.ownerId!),
    );
    await closeOpenClawStateDatabaseAsync();
    sql.clear();
    expect(assertCurrent).toThrow();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("settles snapshot chunks and exclusive removal claims without caller-thread SQL", async () => {
  const { env, database, claim } = await fixture();
  const sql = observeMainThreadSql();
  try {
    const mismatch = claimWorktreeRemovalRow(env, {
      ...claim,
      workerAuthority: {
        predicates: [{ kind: "session-owner", id: claim.worktreeId, sessionKey: "other" }],
      },
    });
    await expect(mismatch).rejects.toBeInstanceOf(SessionWorktreeLifecycleError);
    await expect(mismatch).rejects.toMatchObject({ reason: "owner-mismatch" });
    await expect(
      claimWorktreeRemovalRow(env, {
        ...claim,
        workerAuthority: {
          predicates: [{ kind: "activity", id: claim.worktreeId, lastActiveAt: 99 }],
        },
      }),
    ).rejects.toBeInstanceOf(WorktreeRemovalLockError);
    await expect(
      claimWorktreeRemovalRow(env, {
        ...claim,
        workerAuthority: {
          predicates: [
            {
              kind: "source-record",
              id: "missing-source",
              repoRoot: "synthetic",
              repoFingerprint: "synthetic",
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(SessionWorktreeSourceChangedError);
    await claimWorktreeRemovalRow(env, claim);
    await expect(
      Promise.resolve().then(() => claimWorktreeRemovalRow(env, { ...claim, token: "second" })),
    ).rejects.toBeInstanceOf(WorktreeRemovalContentionError);
    await insertRegistryWorktreeProvisionedChunk(env, {
      worktreeId: claim.worktreeId,
      path: "synthetic.bin",
      chunkIndex: 0,
      data: new Uint8Array([0, 1, 255]),
    });
    await clearRegistryWorktreeProvisionedChunks(env, claim.worktreeId);
    await abortWorktreeRemovalRow(env, claim.worktreeId, "second");
    await expect(
      Promise.resolve().then(() => claimWorktreeRemovalRow(env, { ...claim, token: "second" })),
    ).rejects.toMatchObject({ kind: "busy" });
    await abortWorktreeRemovalRow(env, claim.worktreeId, claim.token);
    await claimWorktreeRemovalRow(env, { ...claim, token: "second" });
    await finalizeWorktreeRemovalRows(env, {
      worktreeId: claim.worktreeId,
      lastActiveAt: 1,
      token: "second",
    });
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  expect(database.db.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
    count: 0,
  });
  expect(
    database.db.prepare("SELECT COUNT(*) AS count FROM worktree_provisioned_file_chunks").get(),
  ).toEqual({ count: 0 });
  await updateRegistryWorktree(env, claim.worktreeId, { lastActiveAt: 2 });
  await admitWorktreeRunLeaseRowAsync(
    captureOpenClawStateWorkerContext({ env }),
    { ...claim, token: "successor" },
    () => {},
  );
  await expect(
    finalizeWorktreeRemovalRows(env, {
      worktreeId: claim.worktreeId,
      lastActiveAt: 1,
      token: "second",
    }),
  ).rejects.toMatchObject({ kind: "finalized" });
  await expect(claimWorktreeRemovalRow(env, claim)).rejects.toMatchObject({
    kind: "busy",
    blockedByRun: { worktreeId: claim.worktreeId, pid: process.pid },
  });
  expect(
    database.db
      .prepare("SELECT lease_key FROM state_leases WHERE scope = ?")
      .all("worktree-run:synthetic"),
  ).toEqual([{ lease_key: "successor" }]);
});

it("keeps session worktree row reads out of worker admission callbacks", async () => {
  const root = dirs.make("session-worktree-worker-guards-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const repoRoot = await initializeRepository(root);
  const record = await materializeManagedWorktreeFixture({
    env,
    stateDir: root,
    repoRoot,
    name: "session-guard",
    ownerKind: "session",
    ownerId: "agent:main:worker-guard",
    now: 1,
  });
  const reads = observeMainThreadReads();
  const worktreeReads: string[] = [];
  let grants = 0;
  const createAdmission = admissions.createSqliteWorkerOperationAdmission;
  const admission = vi
    .spyOn(admissions, "createSqliteWorkerOperationAdmission")
    .mockImplementation((handler, ...options) =>
      createAdmission(
        (request, grant) => {
          grants += 1;
          reads.clear();
          try {
            return handler(request, grant);
          } finally {
            for (const call of reads.calls) {
              for (const statement of call.mock.contexts) {
                if (
                  statement instanceof StatementSync &&
                  /\bworktrees\b/u.test(statement.sourceSQL)
                ) {
                  worktreeReads.push(statement.sourceSQL);
                }
              }
            }
          }
        },
        ...options,
      ),
    );
  try {
    await expect(
      removeSessionWorktree({
        env,
        id: record.id,
        sessionKey: "agent:main:worker-guard",
        reason: "worker-guard-regression",
      }),
    ).resolves.toBeUndefined();
    expect(grants).toBeGreaterThan(0);
    expect(worktreeReads).toEqual([]);
  } finally {
    admission.mockRestore();
    reads.restore();
  }
  expect(getRegistryWorktree(env, record.id)?.removedAt).toEqual(expect.any(Number));
});

it("preserves committed bytes after reply loss, rolls back refused commits, and fences unknown cleanup", async () => {
  const { env, database } = await fixture();
  const input = {
    worktreeId: "synthetic",
    path: "retained.bin",
    chunkIndex: 0,
    data: new Uint8Array([9, 8, 7]),
  };
  const run = stateWorker.runOpenClawStateWorkerOperation;
  let writes = 0;
  const lostReply = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      run(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "worktrees.writeProvisionedSnapshot") {
                writes += 1;
                throw new Error("Synthetic lost command reply");
              }
              return result;
            },
          }),
        options,
      ),
    );
  try {
    await insertRegistryWorktreeProvisionedChunk(env, input);
  } finally {
    lostReply.mockRestore();
  }
  expect(writes).toBe(1);

  const revoked = new Error("Synthetic current owner revoked at commit");
  let current = true;
  const createAdmission = admissions.createSqliteWorkerOperationAdmission;
  const revoke = vi
    .spyOn(admissions, "createSqliteWorkerOperationAdmission")
    .mockImplementation((handler, ...options) =>
      createAdmission(
        (request, grant) => {
          if (request.stage === "commit") {
            current = false;
          }
          return handler(request, grant);
        },
        ...options,
      ),
    );
  try {
    await expect(
      clearRegistryWorktreeProvisionedChunks(env, "synthetic", {
        assertCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
      }),
    ).rejects.toBe(revoked);
  } finally {
    revoke.mockRestore();
  }
  expect(
    database.db.prepare("SELECT hex(data) AS content FROM worktree_provisioned_file_chunks").get(),
  ).toEqual({ content: "090807" });

  const uncertain = new SqliteWorkerError("Synthetic lost native settlement", "outcome-unknown");
  let unknownWrites = 0;
  const loseSettlement = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      run(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              if (command.type === "worktrees.writeProvisionedSnapshot") {
                unknownWrites += 1;
              }
              return scope.execute(command, executeOptions);
            },
          }),
        {
          ...options,
          createAdmission: (retained) => {
            if (!options?.createAdmission) {
              throw new Error("Expected run-end transaction admission");
            }
            const result = options.createAdmission({
              settled: retained.settled.then(() => ({ kind: "unknown", error: uncertain })),
            });
            Object.defineProperty(result.admission, "committed", { get: () => undefined });
            return result;
          },
        },
      ),
    );
  try {
    await withWorktreeRunEnd(env, async () => {
      const context = captureOpenClawStateWorkerContext({ env });
      const accept = captureWorktreeRegistryReadGuard(context, "exact-owner");
      const assertCurrent = accept(await readRegistryWorktree(context, input.worktreeId));
      await expect(
        insertRegistryWorktreeProvisionedChunk(env, { ...input, chunkIndex: 1 }),
      ).rejects.toMatchObject({ code: "outcome-unknown" });
      expect(assertCurrent).toThrow("owner or lifecycle changed");
      await expect(
        Promise.resolve().then(() => clearRegistryWorktreeProvisionedChunks(env, "synthetic")),
      ).rejects.toMatchObject({ code: "outcome-unknown" });
    });
  } finally {
    loseSettlement.mockRestore();
  }
  expect(unknownWrites).toBe(1);
  expect(
    database.db
      .prepare("SELECT chunk_index FROM worktree_provisioned_file_chunks ORDER BY chunk_index")
      .all(),
  ).toEqual([{ chunk_index: 0 }, { chunk_index: 1 }]);
});
