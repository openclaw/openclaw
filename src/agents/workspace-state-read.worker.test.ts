import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { withOpenClawStateDatabaseReadSnapshot as withSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  openOpenClawStateDatabase as openDatabase,
  runOpenClawStateWriteTransaction as writeTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { DuplicateAgentError } from "./agent-create-error.js";
import { resolveBootstrapFilesForPreparation as bootstrap } from "./bootstrap-files.js";
import {
  readWorkspaceFileCache as readCache,
  writeWorkspaceFileCache as writeCache,
} from "./workspace-file-cache.js";
import { assertConfiguredWorkspaceStateReady as assertReady } from "./workspace-state-dirs.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace as expire,
  deleteWorkspaceState as remove,
  mergeWorkspaceSetupState as merge,
  prepareWorkspaceStateDeletion as deletionPlan,
  readWorkspaceStateSnapshot as read,
  replaceWorkspaceAttestation as attest,
} from "./workspace-state-store.js";

const expiredAt = 24 * 60 * 60 * 1000 + 2_001;
const seededAt = "2026-07-16T01:00:00.000Z";
const completedAt = "2026-07-16T02:00:00.000Z";
const milestone = { setupCompletedAt: completedAt };

let state: OpenClawTestState;
let dir: string;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-reader-" });
  dir = state.workspaceDir;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
  await state.cleanup();
});

async function seed() {
  await merge(dir, { bootstrapSeededAt: seededAt }, 1_000);
  await attest(attestation(1_000, "AGENTS.md", "a"));
  return await read(dir);
}
function attestation(at: number, file: string, hash: string) {
  return {
    workspaceDir: dir,
    attestedAtMs: at,
    nowMs: at,
    generatedHashes: new Map([[file, hash.repeat(64)]]),
  };
}
function link(alias: string, target = dir) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}
function replacementAlias() {
  const alias = state.path("alias"),
    replacement = state.path("replacement");
  fs.mkdirSync(replacement);
  link(alias);
  return { alias, replacement };
}

async function withoutMainThreadSql<T>(run: () => Promise<T>): Promise<T> {
  const sql = observeMainThreadSql();
  using _ = { [Symbol.dispose]: () => sql.restore() };
  const result = await run();
  sql.expectIdle();
  return result;
}

it("reuses unchanged workspace facts and refreshes them after each owning write", async () => {
  expect((await read(dir)).setupExists).toBe(false);
  const initial = await seed();
  expect(initial.setup.bootstrapSeededAt).toBe(seededAt);
  const execute = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
  const unchanged = await withoutMainThreadSql(() => read(dir));
  expect(unchanged).toEqual(initial);
  expect(execute).not.toHaveBeenCalled();

  await merge(dir, milestone);
  execute.mockClear();
  expect((await read(dir)).setup.setupCompletedAt).toBe(completedAt);
  expect(execute).not.toHaveBeenCalled();
  await attest(attestation(2_000, "TOOLS.md", "b"));
  execute.mockClear();
  expect((await read(dir)).attestation).toEqual({
    attestedAtMs: 2_000,
    generatedHashes: new Map([["TOOLS.md", "b".repeat(64)]]),
  });
  expect(execute).not.toHaveBeenCalled();
  await remove(deletionPlan(dir));
  expect(await read(dir)).toMatchObject({ setupExists: false, setup: { version: 1 } });
});

it("rolls back setup when a recovery hold arrives after caller preparation", async () => {
  const initial = await seed();
  writeTransaction((database) => {
    database.db.exec("DROP TABLE agent_deletion_journal");
    reconstructAgentDeletionJournal(database, [
      { agentId: "new", path: state.path("held.sqlite") },
    ]);
  });
  await withoutMainThreadSql(async () => {
    const refusal = await merge(dir, milestone, 2_000, {
      recoveryHoldPredicate: { agentId: "new", held: [], applies: true },
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DuplicateAgentError);
    expect(await read(dir)).toEqual(initial);
  });
});

it.each(["merge", "delete"] as const)("rejects revoked %s", async (operation) => {
  const initial = await seed();
  const alias = state.path("grant-alias");
  link(alias);
  for (const stage of ["transaction", "commit"] as const) {
    let retired = false;
    const refusal = new Error("workspace owner retired");
    const spy = probe.admission(workerAdmission, (request, grant, admit) => {
      retired ||= request.stage === stage;
      admit(request, grant);
    });
    const options = {
      assertCurrent: () => {
        if (retired) {
          throw refusal;
        }
      },
    };
    const pending =
      operation === "merge"
        ? merge(alias, milestone, 2_000, options)
        : remove(deletionPlan(alias), options);
    await expect(pending).rejects.toBe(refusal);
    spy.mockRestore();
    expect(retired).toBe(true);
    expect(await read(dir)).toEqual(initial);
  }
  fs.unlinkSync(alias);
  expect((await read(alias)).setupExists).toBe(false);
});

it.each(["transaction", "commit"] as const)("refuses expiry after %s restore", async (stage) => {
  const initial = await seed();
  const filePath = path.join(dir, "AGENTS.md");
  writeCache({ filePath, content: "cached", identity: "identity" });
  let restored = false;
  const spy = probe.admission(workerAdmission, (request, grant, admit) => {
    if (!restored && request.stage === stage) {
      fs.writeFileSync(filePath, "Restored workspace instructions.");
      restored = true;
    }
    admit(request, grant);
  });
  await expect(expire(dir, expiredAt)).rejects.toThrow("Workspace filesystem changed");
  spy.mockRestore();
  expect(restored).toBe(true);
  expect(await read(dir)).toEqual(initial);
  expect(readCache(filePath, "identity")).toBe("cached");
});

it.each(["expiry", "deletion"] as const)("retires %s cache on lost reply", async (cleanup) => {
  await seed();
  const filePath = path.join(dir, "AGENTS.md");
  writeCache({ filePath, content: "cached", identity: "identity" });
  const execute = stateWorker.runOpenClawStateWorkerOperation;
  const spy = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async (...args) => {
      await execute(...args);
      throw new Error("workspace cleanup reply lost");
    });
  await expect(
    cleanup === "deletion" ? remove(deletionPlan(dir)) : expire(dir, expiredAt),
  ).rejects.toThrow("workspace cleanup reply lost");
  spy.mockRestore();
  expect(readCache(filePath, "identity")).toBeUndefined();
  expect((await read(dir)).setupExists).toBe(false);
});

it("keeps captured first-writer setup milestones across queued merges and reopen", async () => {
  await seed();
  const next = { ...milestone };
  const first = merge(dir, next, 2_000);
  next.setupCompletedAt = "2026-07-17T02:00:00.000Z";
  const second = merge(dir, next, 3_000);
  expect((await first).setupCompletedAt).toBe(completedAt);
  expect((await second).setupCompletedAt).toBe(completedAt);
  await closeDatabase();
  expect((await read(dir)).setup.setupCompletedAt).toBe(completedAt);
});

it("rolls back alias registration when its symlink is repointed before commit", async () => {
  const initial = await seed();
  const { alias, replacement } = replacementAlias();
  const spy = probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      fs.unlinkSync(alias);
      link(alias, replacement);
    }
    admit(request, grant);
  });
  await expect(read(alias)).rejects.toBeInstanceOf(WorkspaceAliasRepointedError);
  spy.mockRestore();
  fs.unlinkSync(alias);
  expect((await read(alias)).setupExists).toBe(false);
  expect(await read(dir)).toEqual(initial);
});

it("joins a granted workspace mutation before closing its database", async () => {
  await seed();
  let close: Promise<void> | undefined;
  let closed = false;
  const spy = probe.admission(workerAdmission, (request, grant, admit) => {
    admit(request, () => {
      const granted = grant();
      if (request.stage === "commit") {
        close = closeDatabase().then(() => {
          closed = true;
        });
        expect(closed).toBe(false);
      }
      return granted;
    });
  });
  await expect(merge(dir, milestone, 2_000)).rejects.toMatchObject({
    message: "SQLite committed facts publication failed",
    code: "outcome-unknown",
    cause: {
      message: "OpenClaw state database read admission is closed",
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    },
  });
  expect(close).toBeDefined();
  await close;
  spy.mockRestore();
  expect(closed).toBe(true);
  expect((await read(dir)).setup.setupCompletedAt).toBe(completedAt);
});

it.each([false, true])("prepares bootstrap without SQL: completed=%s", async (completed) => {
  await seed();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Synthetic agent instructions.\n");
  fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "Synthetic setup instructions.\n");
  if (completed) {
    await merge(dir, milestone);
  }
  await closeDatabase();
  const files = await withoutMainThreadSql(() => bootstrap({ workspaceDir: dir }));
  expect(files.find((file) => file.name === "AGENTS.md")?.content).toContain(
    "Synthetic agent instructions.",
  );
  // Preparation treats read errors as incomplete setup, so success alone is insufficient.
  expect(files.some((file) => file.name === "BOOTSTRAP.md")).toBe(!completed);
});

it("keeps workspace reads on the selected composite snapshot", async () => {
  const initial = await seed();
  await withSnapshot(async () => {
    await merge(dir, milestone);
    expect(await withoutMainThreadSql(() => read(dir, { readOnly: true }))).toEqual(initial);
  });
  expect((await read(dir, { readOnly: true })).setup.setupCompletedAt).toBe(completedAt);
});

it("reads committed workspace state while the cached writer has an open transaction", async () => {
  const initial = await seed();
  const database = openDatabase();
  database.db.exec("BEGIN IMMEDIATE");
  using _ = { [Symbol.dispose]: () => database.db.exec("ROLLBACK") };
  database.db.prepare("UPDATE workspace_setup_state SET setup_completed_at = ?").run(completedAt);
  expect(await withoutMainThreadSql(() => read(dir, { database, readOnly: true }))).toEqual(
    initial,
  );
  expect(database.db.isOpen).toBe(true);
});

it("preserves repointed workspace alias error identity and repair details", async () => {
  await seed();
  const { alias, replacement } = replacementAlias();
  await read(alias);
  fs.unlinkSync(alias);
  link(alias, replacement);
  await closeDatabase();
  const error = await withoutMainThreadSql(() =>
    assertReady({
      cfg: { agents: { defaults: { workspace: alias, sandbox: { mode: "off" } } } },
      env: state.env,
      operation: "doctor",
    }).catch((caught: unknown) => caught),
  );
  expect(error).toBeInstanceOf(WorkspaceAliasRepointedError);
  expect(error).toMatchObject({
    aliasPath: path.normalize(alias),
    storedWorkspacePath: path.normalize(dir),
    currentWorkspacePath: path.normalize(replacement),
  });
});
