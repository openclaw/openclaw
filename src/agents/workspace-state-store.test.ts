// SQLite workspace state tests cover persistence, monotonic setup completion,
// and atomic attestation hash replacement.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  readWorkspaceFileCache,
  retireWorkspaceFileCache,
  writeWorkspaceFileCache,
} from "./workspace-file-cache.js";
import {
  resolveWorkspaceStateIdentity,
  WorkspaceAliasRepointedError,
} from "./workspace-state-identity.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace,
  deleteWorkspaceState,
  mergeWorkspaceSetupState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
} from "./workspace-state-store.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-store-",
  });
});

afterEach(async () => {
  if (testState) {
    retireWorkspaceFileCache(testState.workspaceDir);
  }
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

function workspaceDir(): string {
  if (!testState) {
    throw new Error("test state unavailable");
  }
  return testState.workspaceDir;
}

async function deleteState(targetDir: string): Promise<void> {
  await deleteWorkspaceState(prepareWorkspaceStateDeletion(targetDir));
}

function insertPersistedAttestationHash(filename: string, sha256: string): void {
  const identity = resolveWorkspaceStateIdentity(workspaceDir());
  const db = openOpenClawStateDatabase().db;
  db.prepare(
    `INSERT INTO workspace_setup_state (
      workspace_key, workspace_path, attested_at_ms, attestation_updated_at_ms
    ) VALUES (?, ?, 1, 1)`,
  ).run(identity.workspaceKey, identity.workspacePath);
  db.prepare(
    "INSERT INTO workspace_generated_bootstrap_hashes (workspace_key, filename, sha256) VALUES (?, ?, ?)",
  ).run(identity.workspaceKey, filename, sha256);
}

describe("workspace state store", () => {
  it("does not create shared state for a read-only snapshot", async () => {
    const statePath = resolveOpenClawStateSqlitePath(testState!.env);
    expect(fs.existsSync(statePath)).toBe(false);

    expect(
      await readWorkspaceStateSnapshot(workspaceDir(), {
        env: testState!.env,
        readOnly: true,
      }),
    ).toMatchObject({ setupExists: false, setup: { version: 1 } });
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("round-trips setup and attestation state after a database restart", async () => {
    const dir = workspaceDir();
    await mergeWorkspaceSetupState(dir, {
      bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
      setupCompletedAt: "2026-07-16T02:00:00.000Z",
    });
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 1_752_628_800_000,
      generatedHashes: new Map([
        ["AGENTS.md", "a".repeat(64)],
        ["TOOLS.md", "b".repeat(64)],
      ]),
    });

    closeOpenClawStateDatabaseForTest();

    const snapshot = await readWorkspaceStateSnapshot(dir);
    expect(snapshot.setupExists).toBe(true);
    expect(snapshot.setup).toStrictEqual({
      version: 1,
      bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
      setupCompletedAt: "2026-07-16T02:00:00.000Z",
    });
    expect(snapshot.attestation?.attestedAtMs).toBe(1_752_628_800_000);
    expect([...snapshot.attestation!.generatedHashes.entries()]).toStrictEqual([
      ["AGENTS.md", "a".repeat(64)],
      ["TOOLS.md", "b".repeat(64)],
    ]);
  });

  it.each(["HEARTBEAT.md", "RETIRED.md"])(
    "reads a persisted hash for a retired or unknown bootstrap filename: %s",
    async (filename) => {
      insertPersistedAttestationHash(filename, "a".repeat(64));

      expect([
        ...(
          await readWorkspaceStateSnapshot(workspaceDir())
        ).attestation!.generatedHashes.entries(),
      ]).toStrictEqual([[filename, "a".repeat(64)]]);
    },
  );

  it.each([
    "../AGENTS.md",
    "nested\\AGENTS.md",
    "C:outside.md",
    "NUL.md",
    "com1.md",
    "CON.md",
    "COM¹.md",
    "CONIN$.md",
    "CONOUT$.md",
    ".hidden.md",
  ])("rejects an unsafe persisted attestation filename: %s", async (filename) => {
    insertPersistedAttestationHash(filename, "a".repeat(64));

    await expect(readWorkspaceStateSnapshot(workspaceDir())).rejects.toThrow(
      "workspace attestation hash row is invalid",
    );
  });

  it("rejects a malformed persisted attestation hash", async () => {
    insertPersistedAttestationHash("AGENTS.md", "a".repeat(63));

    await expect(readWorkspaceStateSnapshot(workspaceDir())).rejects.toThrow(
      "workspace attestation hash row is invalid",
    );
  });

  it.each(["merge", "attest", "expire", "delete", "register-alias"] as const)(
    "checks current ownership inside the %s transaction before changing state",
    async (operation) => {
      const dir = workspaceDir();
      const alias = testState!.path("workspace-link");
      await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
      await replaceWorkspaceAttestation({
        workspaceDir: dir,
        attestedAtMs: 1_000,
        generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
        nowMs: 1_000,
      });
      const before = await readWorkspaceStateSnapshot(dir);
      const db = openOpenClawStateDatabase().db;
      fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
      const filePath = path.join(dir, "AGENTS.md");
      writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
      const retired = new Error("workspace owner retired");
      const assertCurrent = () => {
        expect(db.isTransaction).toBe(true);
        throw retired;
      };
      const operations = {
        merge: () =>
          mergeWorkspaceSetupState(dir, { setupCompletedAt: "2026-07-16T02:00:00.000Z" }, 2_000, {
            assertCurrent,
          }),
        attest: () =>
          replaceWorkspaceAttestation({
            workspaceDir: dir,
            attestedAtMs: 2_000,
            generatedHashes: new Map([["AGENTS.md", "b".repeat(64)]]),
            nowMs: 2_000,
            assertCurrent,
          }),
        expire: () =>
          clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001, { assertCurrent }),
        delete: () => deleteWorkspaceState(prepareWorkspaceStateDeletion(dir), { assertCurrent }),
        "register-alias": () => readWorkspaceStateSnapshot(alias, { assertCurrent }),
      };

      await expect(operations[operation]()).rejects.toBe(retired);
      expect(await readWorkspaceStateSnapshot(dir)).toEqual(before);
      expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");
      expect(
        db.prepare("SELECT alias_key FROM workspace_path_aliases WHERE alias_path = ?").get(alias),
      ).toBeUndefined();
    },
  );

  it("never regresses persisted setup milestones", async () => {
    const dir = workspaceDir();
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    await mergeWorkspaceSetupState(dir, { setupCompletedAt: "2026-07-16T02:00:00.000Z" }, 2_000);
    const state = await mergeWorkspaceSetupState(
      dir,
      {
        bootstrapSeededAt: "2026-07-16T03:00:00.000Z",
        setupCompletedAt: "2026-07-16T04:00:00.000Z",
      },
      3_000,
    );

    expect(state).toStrictEqual({
      version: 1,
      bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
      setupCompletedAt: "2026-07-16T02:00:00.000Z",
    });
    expect((await readWorkspaceStateSnapshot(dir)).setup).toStrictEqual(state);
  });

  it("replaces generated hashes atomically and ignores older attestations", async () => {
    const dir = workspaceDir();
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 2_000,
      generatedHashes: new Map([
        ["AGENTS.md", "a".repeat(64)],
        ["TOOLS.md", "b".repeat(64)],
      ]),
      nowMs: 2_000,
    });
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 3_000,
      generatedHashes: new Map([["SOUL.md", "c".repeat(64)]]),
      nowMs: 3_000,
    });
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 1_000,
      generatedHashes: new Map([["USER.md", "d".repeat(64)]]),
      nowMs: 4_000,
    });

    const snapshot = await readWorkspaceStateSnapshot(dir);
    // Attestation-only rows carry NULL setup columns: recording hashes before
    // any setup write must not fabricate setup state.
    expect(snapshot.setupExists).toBe(false);
    const attestation = snapshot.attestation;
    expect(attestation?.attestedAtMs).toBe(3_000);
    expect([...attestation!.generatedHashes.entries()]).toStrictEqual([
      ["SOUL.md", "c".repeat(64)],
    ]);
  });

  it("replaces a future-dated attestation with a live refresh", async () => {
    const dir = workspaceDir();
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 100_000,
      generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
      nowMs: 100_000,
    });

    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 2_000,
      generatedHashes: new Map([["TOOLS.md", "b".repeat(64)]]),
      nowMs: 2_000,
    });

    const attestation = (await readWorkspaceStateSnapshot(dir)).attestation;
    expect(attestation?.attestedAtMs).toBe(2_000);
    expect([...attestation!.generatedHashes.entries()]).toStrictEqual([
      ["TOOLS.md", "b".repeat(64)],
    ]);
  });

  it("preserves future-dated state for a vanished workspace", async () => {
    const dir = workspaceDir();
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 100_000,
      generatedHashes: new Map(),
      nowMs: 100_000,
    });

    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 2_000)).toBe(false);
    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(true);
    expect((await readWorkspaceStateSnapshot(dir)).attestation?.attestedAtMs).toBe(100_000);
  });

  it("preserves recent setup-only state and cached content for a vanished workspace", async () => {
    const dir = workspaceDir();
    const filePath = path.join(dir, "AGENTS.md");
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });

    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 2_000)).toBe(false);
    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(true);
    expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");
  });

  it("keeps symlink aliases on one identity after the workspace target vanishes", async () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const identity = resolveWorkspaceStateIdentity(dir);

    expect(resolveWorkspaceStateIdentity(alias)).toStrictEqual(identity);
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    fs.rmSync(dir, { recursive: true, force: true });

    expect(resolveWorkspaceStateIdentity(alias)).toStrictEqual(identity);
    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(alias, 2_000)).toBe(false);
    expect((await readWorkspaceStateSnapshot(alias)).setupExists).toBe(true);
  });

  it("uses a persisted alias after the configured symlink itself disappears", async () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const identity = resolveWorkspaceStateIdentity(dir);
    await mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);

    fs.unlinkSync(alias);

    expect(resolveWorkspaceStateIdentity(alias)).not.toStrictEqual(identity);
    expect((await readWorkspaceStateSnapshot(alias)).identity).toStrictEqual(identity);
    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(alias, 2_000)).toBe(false);
  });

  it("registers missing aliases in the caller-selected state database", async () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: testState!.path("custom-state"),
    };
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const identity = resolveWorkspaceStateIdentity(dir);
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000, {
      env,
    });

    expect((await readWorkspaceStateSnapshot(alias, { env })).identity).toStrictEqual(identity);
    fs.unlinkSync(alias);

    expect((await readWorkspaceStateSnapshot(alias, { env })).identity).toStrictEqual(identity);
    expect((await readWorkspaceStateSnapshot(alias, { env })).setupExists).toBe(true);
    expect(resolveOpenClawStateSqlitePath(env)).not.toBe(resolveOpenClawStateSqlitePath());
    expect((await readWorkspaceStateSnapshot(alias)).setupExists).toBe(false);
  });

  it("does not register missing aliases through a read-only database", async () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: testState!.path("custom-state"),
    };
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000, {
      env,
    });
    closeOpenClawStateDatabaseForTest();
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const database = await openExistingOpenClawStateDatabaseReadOnly({ env });
    if (!database) {
      throw new Error("expected read-only database");
    }

    try {
      expect(
        (await readWorkspaceStateSnapshot(alias, { database, env, readOnly: true })).setupExists,
      ).toBe(true);
    } finally {
      database.walMaintenance.close();
    }
    fs.unlinkSync(alias);

    expect((await readWorkspaceStateSnapshot(alias, { env })).setupExists).toBe(false);
  });

  it("fails closed when a persisted symlink alias is repointed", async () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    await mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    await expect(readWorkspaceStateSnapshot(alias)).rejects.toThrow(WorkspaceAliasRepointedError);
    await expect(readWorkspaceStateSnapshot(alias)).rejects.toThrow(/different current target/u);
  });

  it("cleans current state and only the stale association for a repointed alias", async () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    await mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    await mergeWorkspaceSetupState(
      replacement,
      { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" },
      2_000,
    );
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    const deletion = prepareWorkspaceStateDeletion(alias);
    fs.unlinkSync(alias);
    await deleteWorkspaceState(deletion);

    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(true);
    expect((await readWorkspaceStateSnapshot(replacement)).setupExists).toBe(false);
    const staleAlias = openOpenClawStateDatabase()
      .db.prepare("SELECT alias_key FROM workspace_path_aliases WHERE alias_path = ?")
      .get(alias);
    expect(staleAlias).toBeUndefined();
  });

  it.each([
    { cleanup: "delete", name: "plain" },
    { cleanup: "delete", name: "cafe\u0301" },
    { cleanup: "expire", name: "plain" },
    { cleanup: "expire", name: "cafe\u0301" },
  ])(
    "$cleanup retires cached content through a missing alias ($name)",
    async ({ cleanup, name }) => {
      const dir = path.join(workspaceDir(), name);
      fs.mkdirSync(dir);
      const canonicalDir = fs.realpathSync(dir);
      const alias = testState!.path("workspace-link");
      const filePath = path.join(canonicalDir, "AGENTS.md");
      fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
      await mergeWorkspaceSetupState(
        alias,
        { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" },
        1_000,
      );
      writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
      fs.unlinkSync(alias);

      if (cleanup === "delete") {
        await deleteState(alias);
      } else {
        expect(await clearExpiredWorkspaceStateForVanishedWorkspace(alias, 86_401_001)).toBe(true);
      }

      expect(readWorkspaceFileCache(filePath, "identity")).toBeUndefined();
      expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(false);
      const aliases = openOpenClawStateDatabase()
        .db.prepare("SELECT alias_key FROM workspace_path_aliases")
        .all();
      expect(aliases).toEqual([]);
    },
  );

  it.each(["delete", "expire"])("keeps cached files when %s fails", async (cleanup) => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const filePath = path.join(dir, "AGENTS.md");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    await mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
    const deletion = prepareWorkspaceStateDeletion(alias);
    openOpenClawStateDatabase()
      .db.prepare("UPDATE workspace_path_aliases SET alias_path = ? WHERE alias_path = ?")
      .run(`${alias}-mismatch`, alias);

    try {
      await expect(
        cleanup === "delete"
          ? deleteWorkspaceState(deletion)
          : clearExpiredWorkspaceStateForVanishedWorkspace(alias, 86_401_001),
      ).rejects.toThrow(/alias key collision/u);
      expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");
    } finally {
      retireWorkspaceFileCache(dir);
    }
  });

  it.each(["delete", "expire"])("keeps %s cache entries when the commit fails", async (cleanup) => {
    const dir = workspaceDir();
    const filePath = path.join(dir, "AGENTS.md");
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TABLE workspace_commit_guard (
        workspace_key TEXT REFERENCES workspace_setup_state(workspace_key)
          DEFERRABLE INITIALLY DEFERRED
      )`);
    db.prepare("INSERT INTO workspace_commit_guard VALUES (?)").run(
      resolveWorkspaceStateIdentity(dir).workspaceKey,
    );
    const remove = async () =>
      cleanup === "delete"
        ? await deleteState(dir)
        : await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001);

    await expect(remove()).rejects.toThrow(/FOREIGN KEY constraint failed/u);
    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(true);
    expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");

    db.exec("DELETE FROM workspace_commit_guard");
    await remove();
    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(false);
    expect(readWorkspaceFileCache(filePath, "identity")).toBeUndefined();
  });

  it("retires canonical cached files after deleting through an alias", async () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const filePath = path.join(dir, "AGENTS.md");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    await mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
    const deletion = prepareWorkspaceStateDeletion(alias);
    fs.unlinkSync(alias);

    await deleteWorkspaceState(deletion);

    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(false);
    expect(readWorkspaceFileCache(filePath, "identity")).toBeUndefined();
  });

  it("clears expired setup-only state for a vanished workspace", async () => {
    const dir = workspaceDir();
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);

    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001)).toBe(true);
    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(false);
  });

  it("does not protect a markerless setup row", async () => {
    const dir = workspaceDir();
    await mergeWorkspaceSetupState(dir, {}, 1_000);

    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 2_000)).toBe(true);
    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(false);
  });

  it("preserves recent setup state when its attestation is stale", async () => {
    const dir = workspaceDir();
    await mergeWorkspaceSetupState(
      dir,
      { setupCompletedAt: "2026-07-16T01:00:00.000Z" },
      100_000_000,
    );
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 1_000,
      generatedHashes: new Map(),
      nowMs: 1_000,
    });

    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 100_001_000)).toBe(false);
    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(true);
  });

  it("deletes future-version state without parsing it", async () => {
    const dir = workspaceDir();
    const identity = resolveWorkspaceStateIdentity(dir);
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      `INSERT INTO workspace_setup_state (
        workspace_key,
        workspace_path,
        version,
        bootstrap_seeded_at,
        setup_completed_at,
        updated_at
      ) VALUES (?, ?, 99, NULL, NULL, 1)`,
    ).run(identity.workspaceKey, identity.workspacePath);

    await expect(readWorkspaceStateSnapshot(dir)).rejects.toThrow(
      /unsupported workspace setup version 99/u,
    );
    await expect(deleteState(dir)).resolves.toBeUndefined();
    const row = db
      .prepare("SELECT workspace_key FROM workspace_setup_state WHERE workspace_key = ?")
      .get(identity.workspaceKey);
    expect(row).toBeUndefined();
  });

  it("does not recreate a missing database during delete-only cleanup", async () => {
    const dir = workspaceDir();
    const filePath = path.join(dir, "AGENTS.md");
    writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
    const databasePath = resolveOpenClawStateSqlitePath();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });

    await deleteState(dir);

    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.existsSync(path.dirname(databasePath))).toBe(false);
    expect(readWorkspaceFileCache(filePath, "identity")).toBeUndefined();
  });

  it("deletes migration receipts owned by the workspace", async () => {
    const dir = workspaceDir();
    const identity = resolveWorkspaceStateIdentity(dir);
    const db = openOpenClawStateDatabase().db;
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" });
    const insertRun = db.prepare(
      "INSERT INTO migration_runs (id, started_at, finished_at, status, report_json) VALUES (?, 1, 1, 'completed', '{}')",
    );
    insertRun.run("owned-run");
    insertRun.run("unrelated-run");
    const insertReceipt = db.prepare(
      `INSERT INTO migration_sources (
        source_key,
        migration_kind,
        source_path,
        target_table,
        last_run_id,
        status,
        imported_at,
        report_json
      ) VALUES (?, ?, ?, 'workspace_setup_state', ?, 'completed', 1, ?)`,
    );
    insertReceipt.run(
      "owned-receipt",
      WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
      path.join(dir, ".openclaw", "workspace-state.json"),
      "owned-run",
      JSON.stringify({ workspaceKey: identity.workspaceKey }),
    );
    insertReceipt.run(
      "unrelated-receipt",
      WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
      "/other/workspace-state.json",
      "unrelated-run",
      JSON.stringify({ workspaceKey: "other-workspace" }),
    );

    await deleteState(dir);

    const receipts = db
      .prepare("SELECT source_key FROM migration_sources ORDER BY source_key")
      .all();
    expect(receipts).toEqual([{ source_key: "unrelated-receipt" }]);
    const runs = db.prepare("SELECT id FROM migration_runs ORDER BY id").all();
    expect(runs).toEqual([{ id: "unrelated-run" }]);
  });

  it("clears expired missing-workspace state but preserves a concurrent refresh", async () => {
    const dir = workspaceDir();
    await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 1_000,
      generatedHashes: new Map(),
      nowMs: 1_000,
    });

    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001)).toBe(true);
    expect(await readWorkspaceStateSnapshot(dir)).toMatchObject({ setupExists: false });
    expect((await readWorkspaceStateSnapshot(dir)).attestation).toBeUndefined();

    await mergeWorkspaceSetupState(
      dir,
      { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" },
      86_401_000,
    );
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 86_401_000,
      generatedHashes: new Map(),
      nowMs: 86_401_000,
    });
    expect(await clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001)).toBe(false);
    expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(true);
  });
});
