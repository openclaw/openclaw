import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapFilesForPreparation } from "./bootstrap-files.js";
import { assertConfiguredWorkspaceStateReady } from "./workspace-state-dirs.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
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
