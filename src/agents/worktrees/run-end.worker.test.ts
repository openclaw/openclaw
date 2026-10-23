import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import * as admissions from "../../infra/sqlite-worker-operation-admission.js";
import { removeSessionWorktree } from "../../sessions/session-worktree-lifecycle.js";
import { withExistingOpenClawStateSchema } from "../../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  observeMainThreadReads,
  observeMainThreadSql,
} from "../../test-utils/main-thread-sql-spies.test-support.js";
import { renderAssistantRequestFailureCopy } from "../failover/assistant-request-failure-copy.js";
import {
  SessionWorktreeLifecycleError,
  SessionWorktreeSourceChangedError,
  WorktreeRemovalLockError,
} from "./errors.js";
import { insertRegistryWorktreeProvisionedChunk } from "./provisioned-snapshot.test-support.js";
import { worktreeRegistryPublication } from "./registry-publication.js";
import {
  captureWorktreeRegistryReadGuard as captureGuard,
  prepareWorktreeRegistryGuard as prepareGuard,
  readLiveRegistryWorktreeByOwner as readOwner,
  readRegistryWorktree as readWorktree,
} from "./registry-read.js";
import { worktreeGcRevision } from "./registry-read.kernel.js";
import { deferWorktreeCleanup, retireMissingRegistryWorktree } from "./registry-retirement.js";
import {
  abortWorktreeRemovalRow as abortRemoval,
  claimWorktreeRemovalRow,
  clearRegistryWorktreeProvisionedChunks as clearChunks,
  finalizeWorktreeRemovalRows,
  insertRegistryWorktree as insert,
  WorktreeRemovalContentionError,
  updateRegistryWorktree as update,
} from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { withWorktreeRunEnd, prepareWorktreeRunEndClose } from "./run-end-lifecycle.js";
import {
  admitWorktreeRunLeaseRowAsync,
  releaseWorktreeRunLeaseRowAsync,
} from "./run-lease-store.js";
import {
  makeWorktreeRecord,
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { WorktreeRegistryPredicate } from "./types.js";
import { interceptWorktreeWorkerOperation } from "./worker-operation.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const initializeRepository = useManagedWorktreeTestRepository();

function interceptAdmission(
  intercept: (request: admissions.SqliteWorkerAdmissionRequest, admit: () => void) => void,
) {
  const createAdmission = admissions.createSqliteWorkerOperationAdmission;
  return vi
    .spyOn(admissions, "createSqliteWorkerOperationAdmission")
    .mockImplementation((handler, ...options) =>
      createAdmission(
        (request, grant) => intercept(request, () => handler(request, grant)),
        ...options,
      ),
    );
}
function loseReplies(types: string[]) {
  const writes = new Map<string, number>();
  const transport = interceptWorktreeWorkerOperation((execute) => async (command, options) => {
    const result = await execute(command, options);
    if (types.includes(command.type)) {
      writes.set(command.type, (writes.get(command.type) ?? 0) + 1);
      throw new Error("Synthetic lost command reply");
    }
    return result;
  });
  return { restore: () => transport.mockRestore(), count: (type: string) => writes.get(type) ?? 0 };
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it("joins schema-wrapped work and keeps sibling and successor Gateway lifetimes open", async () => {
  const { env, database, clear } = await fixture();
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const schema = <T>(run: () => T) => withExistingOpenClawStateSchema({ path: database.path }, run);
  const first = schema(prepareWorktreeRunEndClose);
  const sibling = prepareWorktreeRunEndClose();
  await withWorktreeRunEnd(env, async () => {
    let queued = Promise.resolve();
    schema(() => {
      queued = clear();
    });
    await expect(queued).rejects.toThrow("schema admission has ended");
  });
  await schema(() => withWorktreeRunEnd(env, clear));
  first.beginClose();
  await first.drain();
  await clear();
  sibling.beginClose();
  const successor = prepareWorktreeRunEndClose();
  await sibling.drain();
  await clear();
  successor.beginClose();
  await successor.drain();
  await expect(clear()).rejects.toThrow("run-end admission is closed");
});

async function fixture() {
  const root = dirs.make("worktree-run-end-worker-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const database = openOpenClawStateDatabase({ env });
  await insert(
    env,
    makeWorktreeRecord(root, "synthetic", {
      ownerId: "agent:main:synthetic",
    }),
  );
  const claim = {
    worktreeId: "synthetic",
    token: "first",
    pid: process.pid,
    startTime: null,
    now: 1,
  };
  const context = captureOpenClawStateWorkerContext({ env });
  return {
    env,
    database,
    claim,
    context,
    claimRemoval: (overrides: Partial<Parameters<typeof claimWorktreeRemovalRow>[1]> = {}) =>
      claimWorktreeRemovalRow(env, { ...claim, ...overrides }),
    finalize: (token: string) =>
      finalizeWorktreeRemovalRows(env, { worktreeId: claim.worktreeId, lastActiveAt: 1, token }),
    guard: (predicate: WorktreeRegistryPredicate) =>
      prepareGuard(context, { predicates: [predicate] }),
    clear: (options?: Parameters<typeof clearChunks>[2]) =>
      clearChunks(env, claim.worktreeId, options),
    chunk: (chunkIndex = 0) =>
      insertRegistryWorktreeProvisionedChunk(env, {
        worktreeId: claim.worktreeId,
        path: "retained.bin",
        chunkIndex,
        data: new Uint8Array([9, 8, 7]),
      }),
    lease: (token: string, now = claim.now) =>
      admitWorktreeRunLeaseRowAsync(context, { ...claim, token, now }, () => {}),
    row: (query: string) => database.db.prepare(query).get(),
    rows: (query: string) => database.db.prepare(query).all(),
  };
}

it("retains SQL-free effect authority across unrelated writes and revokes pending owner changes", async () => {
  const { env, context, guard } = await fixture();
  const acceptSource = captureGuard(context, "source-owner");
  const acceptBinding = captureGuard(context, "binding");
  const acceptPublication = captureGuard(context, "publication");
  const record = (await readOwner(context, "session", "agent:main:synthetic"))!;
  const assertSource = acceptSource(record);
  const assertBinding = acceptBinding(record);
  const assertPublication = acceptPublication(record);
  const assertExactOwner = await guard({ kind: "exact-owner", record });
  const rebind = (repoFingerprint: string, options: Parameters<typeof update>[3]) =>
    update(
      env,
      record.id,
      {
        repositoryIdentity: { repoRoot: record.repoRoot, repoFingerprint },
      },
      options,
    );
  const sql = observeMainThreadSql();
  onTestFinished(() => sql.restore());
  await clearChunks(env, record.id);
  await update(env, record.id, {
    snapshotRef: "refs/openclaw/snapshots/synthetic",
  });
  await insert(env, { ...record, id: "child", ownerId: "agent:main:child" });
  assertSource();
  assertExactOwner();

  await rebind("normalized", {
    workerAuthority: {
      assertCurrent: assertExactOwner,
      predicates: [{ kind: "binding", record }],
    },
  });
  assertExactOwner();
  assertSource();
  expect(assertBinding).toThrow("owner or binding changed");
  expect(assertPublication).toThrow(SessionWorktreeSourceChangedError);

  let pendingChecks = 0;
  const inspectCommit = interceptAdmission((request, admit) => {
    if (request.stage === "commit") {
      pendingChecks += 1;
      expect(assertSource).toThrow(SessionWorktreeSourceChangedError);
      expect(assertExactOwner).toThrow("owner or lifecycle changed");
    }
    return admit();
  });
  await rebind("rebound", { assertCurrent: assertExactOwner });
  inspectCommit.mockRestore();
  expect(pendingChecks).toBeGreaterThan(0);
  expect(assertExactOwner).toThrow("owner or lifecycle changed");

  const acceptReplacement = captureGuard(context, "source-owner");
  const current = (await readWorktree(context, record.id))!;
  const assertSelected = acceptReplacement(current);
  await insert(env, { ...current, id: "replacement", createdAt: 2 });
  expect(assertSelected).toThrow(SessionWorktreeSourceChangedError);
  sql.expectIdle();

  const acceptCurrent = captureGuard(context, "source-owner");
  const assertCurrent = acceptCurrent(await readOwner(context, "session", record.ownerId!));
  await closeOpenClawStateDatabaseAsync();
  sql.clear();
  expect(assertCurrent).toThrow();
  sql.expectIdle();
});

it("distinguishes checkout base and retained snapshot in registry binding predicates", async () => {
  const { context, guard } = await fixture();
  const record = (await readWorktree(context, "synthetic"))!;
  for (const [kind, checked, ignored, error] of [
    ["binding", "baseRef", "snapshotRef", "owner or binding changed"],
    ["exact-snapshot", "snapshotRef", "baseRef", "owner or lifecycle changed"],
  ] as const) {
    await expect(guard({ kind, record: { ...record, [checked]: "another" } })).rejects.toThrow(
      error,
    );
    const assertCurrent = await guard({ kind, record: { ...record, [ignored]: "another" } });
    expect(assertCurrent).not.toThrow();
  }
});

it("settles snapshot chunks and exclusive removal claims without caller-thread SQL", async () => {
  const { env, database, claim, claimRemoval, finalize, chunk, clear, lease, row } =
    await fixture();
  const sql = observeMainThreadSql();
  for (const [predicate, error] of [
    [
      { kind: "session-owner", id: claim.worktreeId, sessionKey: "other" },
      SessionWorktreeLifecycleError,
    ],
    [{ kind: "activity", id: claim.worktreeId, lastActiveAt: 99 }, WorktreeRemovalLockError],
    [
      {
        kind: "source-record",
        id: "missing-source",
        repoRoot: "synthetic",
        repoFingerprint: "synthetic",
      },
      SessionWorktreeSourceChangedError,
    ],
  ] as const) {
    const mismatch = claimRemoval({ workerAuthority: { predicates: [predicate] } });
    await expect(mismatch).rejects.toBeInstanceOf(error);
    if (predicate.kind === "session-owner") {
      await expect(mismatch).rejects.toMatchObject({ reason: "owner-mismatch" });
    }
  }
  await claimRemoval();
  const contention = Promise.resolve().then(() => claimRemoval({ token: "second" }));
  await expect(contention).rejects.toBeInstanceOf(WorktreeRemovalContentionError);
  await expect(contention).rejects.toThrow("worktree removal is already in progress");
  await chunk();
  await clear();
  await abortRemoval(env, claim.worktreeId, "second");
  await expect(
    Promise.resolve().then(() => claimRemoval({ token: "second" })),
  ).rejects.toMatchObject({ kind: "busy" });
  await abortRemoval(env, claim.worktreeId, claim.token);
  await claimRemoval({ token: "second" });
  await finalize("second");
  sql.expectIdle();
  sql.restore();
  for (const table of ["state_leases", "worktree_provisioned_file_chunks"]) {
    expect(row(`SELECT COUNT(*) AS count FROM ${table}`)).toEqual({ count: 0 });
  }
  await update(env, claim.worktreeId, { lastActiveAt: 2 });
  await lease("successor");
  await expect(finalize("second")).rejects.toMatchObject({ kind: "finalized" });
  await expect(claimRemoval()).rejects.toMatchObject({
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
  const admission = interceptAdmission((_request, admit) => {
    grants += 1;
    reads.clear();
    try {
      return admit();
    } finally {
      for (const statement of reads.calls.flatMap((call) => call.mock.contexts)) {
        if (statement instanceof StatementSync && /\bworktrees\b/u.test(statement.sourceSQL)) {
          worktreeReads.push(statement.sourceSQL);
        }
      }
    }
  });
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
  admission.mockRestore();
  reads.restore();
  expect(getRegistryWorktree(env, record.id)?.removedAt).toEqual(expect.any(Number));
});

it("preserves committed bytes after reply loss, rolls back refused commits, and fences unknown cleanup", async () => {
  const { env, context, clear, chunk, lease, row, rows } = await fixture();
  const facts = new Map();
  const readFact = (...key: string[]) => facts.get(JSON.stringify(key));
  const unsubscribe = worktreeRegistryPublication.subscribeFacts((change) => {
    if (change.kind === "committed") {
      for (const [key, fact] of change.receipt.facts) {
        facts.set(key, fact);
      }
    }
  });
  onTestFinished(unsubscribe);
  const lostReply = loseReplies([
    "worktrees.writeProvisionedSnapshot",
    "worktrees.update",
    "worktrees.deferCleanup",
    "worktrees.admitRunLease",
    "worktrees.releaseRunLease",
  ]);
  await chunk();
  await update(env, "synthetic", { lastActiveAt: 2 });
  expect(readFact("worktrees", "synthetic")).toMatchObject({
    kind: "postimage",
    value: { last_active_at: 2 },
  });
  await expect(
    deferWorktreeCleanup(env, {
      observed: getRegistryWorktree(env, "synthetic")!,
      reason: "retained after reply loss",
    }),
  ).resolves.toBe(true);
  await lease("lost-reply", 2);
  const leaseFact = () => readFact("state_leases", "worktree-run:synthetic", "lost-reply");
  expect(leaseFact()).toMatchObject({ kind: "postimage" });
  await releaseWorktreeRunLeaseRowAsync(env, "synthetic", "lost-reply", context);
  expect(leaseFact()).toEqual({ kind: "absent" });
  lostReply.restore();
  unsubscribe();
  expect(lostReply.count("worktrees.writeProvisionedSnapshot")).toBe(1);

  const revoked = new Error("Synthetic current owner revoked at commit");
  let current = true;
  const revoke = interceptAdmission((request, admit) => {
    if (request.stage === "commit") {
      current = false;
    }
    return admit();
  });
  await expect(
    clear({
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
      },
    }),
  ).rejects.toBe(revoked);
  revoke.mockRestore();
  expect(row("SELECT hex(data) AS content FROM worktree_provisioned_file_chunks")).toEqual({
    content: "090807",
  });

  const uncertain = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
  const replyFailure = new Error("Worktree write reply was lost");
  let unknownWrites = 0;
  interceptWorktreeWorkerOperation(
    (execute) => async (command, executeOptions) => {
      if (command.type === "worktrees.writeProvisionedSnapshot") {
        unknownWrites += 1;
        await execute(command, executeOptions);
        throw replyFailure;
      }
      return execute(command, executeOptions);
    },
    (options) => ({
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
    }),
  );
  await withWorktreeRunEnd(env, async () => {
    const runContext = captureOpenClawStateWorkerContext({ env });
    const accept = captureGuard(runContext, "exact-owner");
    const assertCurrent = accept(await readWorktree(runContext, "synthetic"));
    await expect(chunk(1)).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: "outcome-unknown" });
      expect(formatErrorMessageWithCode(error)).toContain(replyFailure.message);
      expect(
        renderAssistantRequestFailureCopy({
          storageFailure: classifyGatewayStorageFailure(error),
        }),
      ).toContain("disk is full. Free up space");
      return true;
    });
    expect(assertCurrent).toThrow("owner or lifecycle changed");
    await expect(Promise.resolve().then(() => clear())).rejects.toMatchObject({
      code: "outcome-unknown",
    });
  });
  expect(unknownWrites).toBe(1);
  expect(
    rows("SELECT chunk_index FROM worktree_provisioned_file_chunks ORDER BY chunk_index"),
  ).toEqual([{ chunk_index: 0 }, { chunk_index: 1 }]);
});

it("preserves retirement commits when combined facts or the recovery result exceed the receipt budget", async () => {
  const { env, database } = await fixture();
  const observed = getRegistryWorktree(env, "synthetic")!;
  const publications: string[] = [];
  const unsubscribe = worktreeRegistryPublication.subscribeFacts((change) => {
    publications.push(change.kind);
  });
  onTestFinished(unsubscribe);
  const lostReply = loseReplies(["worktrees.retireMissing"]);
  // The command stays small: large values are persisted fixture data, not retirement inputs.
  for (const bytes of [
    SQLITE_WORKER_MAX_MESSAGE_BYTES / 2 + 1024,
    SQLITE_WORKER_MAX_MESSAGE_BYTES + 1024,
  ]) {
    const combined = bytes < SQLITE_WORKER_MAX_MESSAGE_BYTES;
    database.db
      .prepare(
        "UPDATE worktrees SET branch = ?, gc_protection_json = ?, removed_at = NULL WHERE id = ?",
      )
      .run(
        combined ? observed.branch : "x".repeat(bytes),
        combined
          ? JSON.stringify({
              revision: worktreeGcRevision({ ...observed, removedAt: 2 }),
              reason: "x".repeat(bytes),
            })
          : null,
        observed.id,
      );
    publications.length = 0;
    const retirement = retireMissingRegistryWorktree(env, observed, 2);
    if (combined) {
      const result = await retirement;
      expect(result.record?.gcProtection?.length).toBe(bytes);
    } else {
      await expect(retirement).rejects.toThrow(
        "retirement committed but its result is unavailable",
      );
    }
    expect(
      database.db.prepare("SELECT removed_at FROM worktrees WHERE id = ?").get(observed.id),
    ).toEqual({ removed_at: 2 });
    expect(publications).toEqual(["pending", "unknown", "settled"]);
  }
  expect(lostReply.count("worktrees.retireMissing")).toBe(2);
});
