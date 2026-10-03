import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { DuplicateAgentError } from "./agent-create-error.js";
import { resolveBootstrapFilesForPreparation } from "./bootstrap-files.js";
import { readWorkspaceFileCache, writeWorkspaceFileCache } from "./workspace-file-cache.js";
import { assertConfiguredWorkspaceStateReady } from "./workspace-state-dirs.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace,
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_ATTESTATION_RECENT_MS,
} from "./workspace-state-store.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-reader-" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

async function seed() {
  await mergeWorkspaceSetupState(
    state.workspaceDir,
    {
      bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
    },
    1_000,
  );
  await replaceWorkspaceAttestation({
    workspaceDir: state.workspaceDir,
    attestedAtMs: 1_000,
    nowMs: 1_000,
    generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
  });
  return await readWorkspaceStateSnapshot(state.workspaceDir);
}

async function withoutMainThreadSql<T>(read: () => Promise<T>): Promise<T> {
  const sql = observeMainThreadSql();
  try {
    const result = await read();
    sql.expectIdle();
    return result;
  } finally {
    sql.restore();
  }
}

it("snapshots, registers aliases, merges setup, and expires exact state without caller-thread SQL", async () => {
  await withoutMainThreadSql(seed);
  await closeOpenClawStateDatabaseAsync();
  const alias = state.path("runtime-alias");
  fs.symlinkSync(state.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
  await withoutMainThreadSql(async () => {
    expect((await readWorkspaceStateSnapshot(alias)).setup.bootstrapSeededAt).toBe(
      "2026-07-16T01:00:00.000Z",
    );
    expect(
      await mergeWorkspaceSetupState(
        alias,
        { bootstrapSeededAt: "2026-07-17T01:00:00.000Z" },
        2_000,
      ),
    ).toEqual({ version: 1, bootstrapSeededAt: "2026-07-16T01:00:00.000Z" });
    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(alias, 2_000)).toBe(false);
    fs.unlinkSync(alias);
    expect(
      await clearExpiredWorkspaceStateForVanishedWorkspace(
        alias,
        WORKSPACE_ATTESTATION_RECENT_MS + 2_001,
      ),
    ).toBe(true);
    expect((await readWorkspaceStateSnapshot(state.workspaceDir)).setupExists).toBe(false);
  });
});

it("rolls back setup when a recovery hold arrives after caller preparation", async () => {
  const before = await seed();
  const recoveryHoldPredicate = { agentId: "new", held: [], applies: true };
  runOpenClawStateWriteTransaction((database) => {
    database.db.exec("DROP TABLE agent_deletion_journal");
    reconstructAgentDeletionJournal(database, [
      { agentId: "new", path: state.path("held.sqlite") },
    ]);
  });
  await withoutMainThreadSql(async () => {
    const refusal = await mergeWorkspaceSetupState(
      state.workspaceDir,
      { setupCompletedAt: "2026-07-16T02:00:00.000Z" },
      2_000,
      { recoveryHoldPredicate },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DuplicateAgentError);
    expect(refusal).toMatchObject({
      message:
        "Agent new has held databases. Restore its original agentDir and session.store configuration, then run agents add explicitly to restore the preserved store.",
    });
    expect(await readWorkspaceStateSnapshot(state.workspaceDir)).toEqual(before);
  });
});

it.each(["snapshot", "merge", "expire"] as const)(
  "rejects revoked authority at transaction and commit for %s",
  async (operation) => {
    const before = await seed();
    const alias = state.path("grant-alias");
    fs.symlinkSync(state.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
    const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    for (const stage of ["transaction", "commit"] as const) {
      let retired = false;
      const refusal = new Error("workspace owner retired");
      const spy = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          originalAdmission((request, grant) => {
            retired ||= request.stage === stage;
            admit(request, grant);
          }, attachment),
        );
      const options = {
        assertCurrent: () => {
          if (retired) {
            throw refusal;
          }
        },
      };
      const pending =
        operation === "snapshot"
          ? readWorkspaceStateSnapshot(alias, options)
          : operation === "merge"
            ? mergeWorkspaceSetupState(
                alias,
                { setupCompletedAt: "2026-07-16T02:00:00.000Z" },
                2_000,
                options,
              )
            : clearExpiredWorkspaceStateForVanishedWorkspace(
                alias,
                WORKSPACE_ATTESTATION_RECENT_MS + 2_001,
                options,
              );
      await expect(pending).rejects.toBe(refusal);
      spy.mockRestore();
      expect(retired).toBe(true);
      expect(await readWorkspaceStateSnapshot(state.workspaceDir)).toEqual(before);
    }
    fs.unlinkSync(alias);
    expect((await readWorkspaceStateSnapshot(alias)).setupExists).toBe(false);
  },
);

it.each(["transaction", "commit"] as const)(
  "refuses expiry when workspace files reappear at %s admission",
  async (stage) => {
    const before = await seed();
    const filePath = path.join(state.workspaceDir, "AGENTS.md");
    writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
    const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let restored = false;
    const spy = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        originalAdmission((request, grant) => {
          if (!restored && request.stage === stage) {
            fs.writeFileSync(filePath, "Restored workspace instructions.");
            restored = true;
          }
          admit(request, grant);
        }, attachment),
      );
    await expect(
      clearExpiredWorkspaceStateForVanishedWorkspace(
        state.workspaceDir,
        WORKSPACE_ATTESTATION_RECENT_MS + 2_001,
      ),
    ).rejects.toThrow("Workspace filesystem changed");
    spy.mockRestore();
    expect(restored).toBe(true);
    expect(await readWorkspaceStateSnapshot(state.workspaceDir)).toEqual(before);
    expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");
  },
);

it("retires committed expiry cache entries when result delivery fails without replay", async () => {
  await seed();
  const filePath = path.join(state.workspaceDir, "AGENTS.md");
  writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
  const execute = stateWorker.runOpenClawStateWorkerOperation;
  const spy = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async (...args) => {
      await execute(...args);
      throw new Error("expiry reply lost");
    });
  await expect(
    clearExpiredWorkspaceStateForVanishedWorkspace(
      state.workspaceDir,
      WORKSPACE_ATTESTATION_RECENT_MS + 2_001,
    ),
  ).rejects.toThrow("expiry reply lost");
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
  expect(readWorkspaceFileCache(filePath, "identity")).toBeUndefined();
  expect((await readWorkspaceStateSnapshot(state.workspaceDir)).setupExists).toBe(false);
});

it("keeps captured first-writer setup milestones across queued merges and reopen", async () => {
  await seed();
  const next = { setupCompletedAt: "2026-07-16T02:00:00.000Z" };
  const first = mergeWorkspaceSetupState(state.workspaceDir, next, 2_000);
  next.setupCompletedAt = "2026-07-17T02:00:00.000Z";
  const second = mergeWorkspaceSetupState(state.workspaceDir, next, 3_000);
  expect((await first).setupCompletedAt).toBe("2026-07-16T02:00:00.000Z");
  expect((await second).setupCompletedAt).toBe("2026-07-16T02:00:00.000Z");
  await closeOpenClawStateDatabaseAsync();
  expect((await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt).toBe(
    "2026-07-16T02:00:00.000Z",
  );
});

it("rolls back alias registration when its symlink is repointed before commit", async () => {
  const before = await seed();
  const alias = state.path("pending-alias");
  const replacement = state.path("new-target");
  fs.mkdirSync(replacement);
  fs.symlinkSync(state.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
  const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const spy = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      originalAdmission((request, grant) => {
        if (request.stage === "commit") {
          fs.unlinkSync(alias);
          fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
        }
        admit(request, grant);
      }, attachment),
    );
  await expect(readWorkspaceStateSnapshot(alias)).rejects.toBeInstanceOf(
    WorkspaceAliasRepointedError,
  );
  spy.mockRestore();
  fs.unlinkSync(alias);
  expect((await readWorkspaceStateSnapshot(alias)).setupExists).toBe(false);
  expect(await readWorkspaceStateSnapshot(state.workspaceDir)).toEqual(before);
});

it("joins a granted workspace mutation before closing its database", async () => {
  await seed();
  let close: Promise<void> | undefined;
  let closed = false;
  const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const spy = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      originalAdmission((request, grant) => {
        admit(request, () => {
          const granted = grant();
          if (request.stage === "commit") {
            close = closeOpenClawStateDatabaseAsync().then(() => {
              closed = true;
            });
            expect(closed).toBe(false);
          }
          return granted;
        });
      }, attachment),
    );
  await expect(
    mergeWorkspaceSetupState(
      state.workspaceDir,
      { setupCompletedAt: "2026-07-16T02:00:00.000Z" },
      2_000,
    ),
  ).rejects.toThrow("read admission is closed");
  expect(close).toBeDefined();
  await close;
  spy.mockRestore();
  expect(closed).toBe(true);
  expect((await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt).toBe(
    "2026-07-16T02:00:00.000Z",
  );
});

it.each([false, true])(
  "prepares bootstrap files for completed=%s without main-thread SQL",
  async (completed) => {
    await seed();
    fs.mkdirSync(state.workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(state.workspaceDir, "AGENTS.md"), "Synthetic agent instructions.\n");
    fs.writeFileSync(
      path.join(state.workspaceDir, "BOOTSTRAP.md"),
      "Synthetic setup instructions.\n",
    );
    if (completed) {
      await mergeWorkspaceSetupState(state.workspaceDir, {
        setupCompletedAt: "2026-07-16T02:00:00.000Z",
      });
    }
    await closeOpenClawStateDatabaseAsync();
    const files = await withoutMainThreadSql(() =>
      resolveBootstrapFilesForPreparation({ workspaceDir: state.workspaceDir }),
    );
    expect(files.find((file) => file.name === "AGENTS.md")?.content).toContain(
      "Synthetic agent instructions.",
    );
    // Preparation treats read errors as incomplete setup, so success alone is insufficient.
    expect(files.some((file) => file.name === "BOOTSTRAP.md")).toBe(!completed);
  },
);

it("keeps an absent workspace database absent", async () => {
  const databasePath = resolveOpenClawStateSqlitePath(state.env);
  expect(
    await withoutMainThreadSql(() =>
      readWorkspaceStateSnapshot(state.workspaceDir, { readOnly: true }),
    ),
  ).toMatchObject({ setupExists: false, setup: { version: 1 } });
  expect(fs.existsSync(databasePath)).toBe(false);
});

it("keeps workspace reads on the selected composite snapshot", async () => {
  const initial = await seed();
  await withOpenClawStateDatabaseReadSnapshot(async () => {
    await mergeWorkspaceSetupState(state.workspaceDir, {
      setupCompletedAt: "2026-07-16T02:00:00.000Z",
    });
    expect(
      await withoutMainThreadSql(() =>
        readWorkspaceStateSnapshot(state.workspaceDir, { readOnly: true }),
      ),
    ).toEqual(initial);
  });
  expect(
    (await readWorkspaceStateSnapshot(state.workspaceDir, { readOnly: true })).setup
      .setupCompletedAt,
  ).toBe("2026-07-16T02:00:00.000Z");
});

it("reads committed workspace state while the cached writer has an open transaction", async () => {
  const expected = await seed();
  const database = openOpenClawStateDatabase();
  database.db.exec("BEGIN IMMEDIATE");
  try {
    database.db
      .prepare("UPDATE workspace_setup_state SET setup_completed_at = ?")
      .run("2026-07-16T02:00:00.000Z");
    expect(
      await withoutMainThreadSql(() =>
        readWorkspaceStateSnapshot(state.workspaceDir, { database, readOnly: true }),
      ),
    ).toEqual(expected);
    expect(database.db.isOpen).toBe(true);
  } finally {
    database.db.exec("ROLLBACK");
  }
});

it("preserves source artifacts and does not repair missing indexes on inspection", async () => {
  const expected = await seed();
  const database = openOpenClawStateDatabase();
  database.db.exec("DROP INDEX idx_task_runs_status");
  const databasePath = database.path;
  await closeOpenClawStateDatabaseAsync();
  const artifacts = () =>
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((file) =>
      fs.existsSync(file) ? fs.readFileSync(file) : null,
    );
  const before = artifacts();
  expect(
    await withoutMainThreadSql(() =>
      withArtifactPreservingStateReads(() =>
        readWorkspaceStateSnapshot(state.workspaceDir, { readOnly: true }),
      ),
    ),
  ).toEqual(expected);
  expect(database.db.isOpen).toBe(false);
  expect(artifacts()).toEqual(before);
});

it("preserves repointed workspace alias error identity and repair details", async () => {
  await seed();
  const alias = state.path("alias");
  const replacement = state.path("replacement");
  fs.mkdirSync(replacement);
  fs.symlinkSync(state.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
  await readWorkspaceStateSnapshot(alias);
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
  await closeOpenClawStateDatabaseAsync();
  const error = await withoutMainThreadSql(() =>
    assertConfiguredWorkspaceStateReady({
      cfg: { agents: { defaults: { workspace: alias, sandbox: { mode: "off" } } } },
      env: state.env,
      operation: "doctor",
    }).catch((caught: unknown) => caught),
  );
  expect(error).toBeInstanceOf(WorkspaceAliasRepointedError);
  expect(error).toMatchObject({
    aliasPath: path.normalize(alias),
    storedWorkspacePath: path.normalize(state.workspaceDir),
    currentWorkspacePath: path.normalize(replacement),
  });
});
