import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
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
import { resolveWorkspaceStateIdentity } from "./workspace-state-identity.js";
import { workspaceStateFactKey, workspaceStatePublication } from "./workspace-state-publication.js";
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
  it("publishes complete hash replacement and exact alias/setup/attestation tombstones", async () => {
    const dir = workspaceDir();
    const identity = resolveWorkspaceStateIdentity(dir);
    const observed = new Map<string, unknown>();
    const unsubscribe = workspaceStatePublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        for (const [key, fact] of change.receipt.facts) {
          observed.set(key, fact);
        }
      }
    });
    try {
      await mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1000);
      const alias = testState!.path("receipt-workspace-link");
      fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
      await readWorkspaceStateSnapshot(alias);
      await replaceWorkspaceAttestation({
        workspaceDir: dir,
        attestedAtMs: 1000,
        nowMs: 1000,
        generatedHashes: new Map([
          ["AGENTS.md", "a".repeat(64)],
          ["TOOLS.md", "b".repeat(64)],
        ]),
      });
      await replaceWorkspaceAttestation({
        workspaceDir: dir,
        attestedAtMs: 2000,
        nowMs: 2000,
        generatedHashes: new Map([["AGENTS.md", "c".repeat(64)]]),
      });
      expect(observed.get(workspaceStateFactKey("hashes", identity.workspaceKey))).toEqual({
        kind: "postimage",
        value: {
          kind: "hashes",
          workspaceKey: identity.workspaceKey,
          hashes: [["AGENTS.md", "c".repeat(64)]],
        },
      });
      expect([...observed.keys()].filter((key) => key.startsWith('["alias",'))).toHaveLength(2);
      await deleteState(alias);
      expect([...observed.values()]).toEqual(Array.from({ length: 4 }, () => ({ kind: "absent" })));
      const deleted = await readWorkspaceStateSnapshot(dir, { readOnly: true });
      expect(deleted.setupExists).toBe(false);
      expect(deleted.attestation).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

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

  it.each(["NUL.md", ".hidden.md"])(
    "rejects an unsafe persisted attestation filename: %s",
    async (filename) => {
      insertPersistedAttestationHash(filename, "a".repeat(64));

      await expect(readWorkspaceStateSnapshot(workspaceDir())).rejects.toThrow(
        "workspace attestation hash row is invalid",
      );
    },
  );

  it("rejects a malformed persisted attestation hash", async () => {
    insertPersistedAttestationHash("AGENTS.md", "a".repeat(63));

    await expect(readWorkspaceStateSnapshot(workspaceDir())).rejects.toThrow(
      "workspace attestation hash row is invalid",
    );
  });

  it("refuses retired ownership before deleting state", async () => {
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
      throw retired;
    };
    await expect(
      deleteWorkspaceState(prepareWorkspaceStateDeletion(dir), { assertCurrent }),
    ).rejects.toBe(retired);
    expect(await readWorkspaceStateSnapshot(dir)).toEqual(before);
    expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");
    expect(
      db.prepare("SELECT alias_key FROM workspace_path_aliases WHERE alias_path = ?").get(alias),
    ).toBeUndefined();
  });

  it("registers and retires aliases in the captured caller-selected state database", async () => {
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

    const selectedPath = resolveOpenClawStateSqlitePath(env);
    const deletion = deleteWorkspaceState(prepareWorkspaceStateDeletion(alias), { env });
    env.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR!;
    await deletion;
    expect((await readWorkspaceStateSnapshot(dir, { path: selectedPath })).setupExists).toBe(false);
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
    insertRun.run("shared-run");
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
      "owned-shared-receipt",
      WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
      path.join(dir, ".openclaw", "workspace-state.json"),
      "shared-run",
      JSON.stringify({ workspaceKey: identity.workspaceKey }),
    );
    insertReceipt.run(
      "retained-receipt",
      "unrelated-migration-kind",
      "/other/source",
      "shared-run",
      "{}",
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
    expect(receipts).toEqual([
      { source_key: "retained-receipt" },
      { source_key: "unrelated-receipt" },
    ]);
    const runs = db.prepare("SELECT id FROM migration_runs ORDER BY id").all();
    expect(runs).toEqual([{ id: "shared-run" }, { id: "unrelated-run" }]);
  });
});
