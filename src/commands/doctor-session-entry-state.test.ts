import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { createSessionSqliteMigrationRun } from "../infra/session-sqlite-migration-manifest.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import * as snapshots from "../infra/sqlite-snapshot.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import * as quarantine from "../state/openclaw-quarantine-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { repairLegacySessionEntryStates } from "./doctor-session-delivery-state.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";
import * as entryRepairs from "./doctor/shared/session-entry-rewrite.js";

let state: OpenClawTestState | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
  state = undefined;
});

function seedEntry(key: string, fields: Record<string, unknown>) {
  const env = state!.env;
  const sessionKey = `agent:main:${key}`;
  const entry = {
    sessionId: `session-${key}`,
    updatedAt: 42,
    delivery: { kind: "none" },
    ...fields,
  };
  const raw = JSON.stringify(entry);
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(sessionKey, entry.sessionId, raw, entry.updatedAt);
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sessionKey);
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES (?, ?, 'conversation', ?, ?)",
    )
    .run(entry.sessionId, sessionKey, entry.updatedAt, entry.updatedAt);
  const readRaw = () => {
    const current = openOpenClawAgentDatabase({ agentId: "main", env });
    return current.db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey)?.entry_json;
  };
  return {
    raw,
    readRaw,
    sessionKey,
    databasePath: database.path,
    scope: { agentId: "main", env, sessionKey, storePath: database.path },
  };
}

it("backs up original rows and migrates pending delivery state before canonical reads", async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-doctor-entry-state-",
    scenario: "minimal",
  });
  const legacy = seedEntry("legacy", {
    pendingFinalDelivery: true,
    pendingFinalDeliveryText: "saved reply",
    pendingFinalDeliveryCreatedAt: 40,
    pendingFinalDeliveryContext: { channel: "telegram", to: "synthetic-recipient", threadId: 3 },
    pendingFinalDeliveryIntentId: "intent-legacy",
    pendingFinalDeliveryAttemptCount: 2,
    fallbackNoticeSelectedModel: "openai/model-a",
    fallbackNoticeActiveModel: "openai/model-b",
    fallbackNoticeReason: "rate-limit",
    memoryFlushCompactionCount: 0,
    memoryFlushFailureCount: 2,
    memoryFlushLastFailureError: "old failure",
    label: "preserved label",
    pluginExtensions: { example: { draft: { text: "Saved operator draft", revisions: [2, 3] } } },
    sessionFile: "sqlite:main:session-legacy:/synthetic/sessions.json",
    transcriptPath: "retained-transcript-locator",
    archivedBy: { type: "human", id: "prior-archiver" },
  });
  const transport = seedEntry("transport", { pendingFinalDelivery: true });
  const cleared = seedEntry("cleared", { pendingFinalDelivery: false });
  const nullLegacyField = seedEntry("null-legacy-field", { memoryFlushAt: null });
  const canonicalPending = {
    kind: "replayable",
    text: "current reply",
    createdAt: 39,
    intentId: "current-intent",
    deliveries: [{ id: "delivery-current", state: "queued" }],
  };
  const current = seedEntry("current", {
    pendingFinalDelivery: { ...canonicalPending, artifactHint: "preserve opaque state metadata" },
    pendingFinalDeliveryText: "superseded reply",
    fallbackNotice: { kind: "active", selectedModel: "current-a", activeModel: "current-b" },
    fallbackNoticeSelectedModel: "old-a",
    fallbackNoticeActiveModel: "old-b",
    memoryFlush: { kind: "succeeded", compactionCount: 7 },
    memoryFlushCompactionCount: 1,
    memoryFlushFailureCount: 2,
  });
  const unchanged = seedEntry("unchanged", { pendingFinalDelivery: canonicalPending });
  const db = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const snapshot = { prompt: "retained snapshot", skills: [] };
  db.db
    .prepare(
      "INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (?, 'skillsSnapshot', ?)",
    )
    .run(legacy.sessionKey, JSON.stringify(snapshot));

  expect(() => loadExactSessionEntryReadOnly(legacy.scope)).toThrow(/run openclaw doctor --fix/);
  expect(await repairLegacySessionEntryStates({ apply: false, cfg: {}, env: state.env })).toEqual({
    found: 5,
    repaired: 0,
    scannedStores: 1,
  });
  expect(legacy.readRaw()).toBe(legacy.raw);
  const report = await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "session entry state test",
    run: (authority) =>
      repairLegacySessionEntryStates({ apply: true, cfg: {}, env: state!.env, authority }),
  });
  expect(report).toMatchObject({ found: 5, repaired: 5 });
  expect(JSON.parse(String(cleared.readRaw()))).not.toHaveProperty("pendingFinalDelivery");
  expect(JSON.parse(String(nullLegacyField.readRaw()))).not.toHaveProperty("memoryFlushAt");
  expect(unchanged.readRaw()).toBe(unchanged.raw);
  expect(JSON.parse(String(current.readRaw())).pendingFinalDelivery).toEqual({
    ...canonicalPending,
    artifactHint: "preserve opaque state metadata",
  });
  expect(legacy.readRaw()).not.toContain("pendingFinalDeliveryText");
  expect(JSON.parse(String(legacy.readRaw())).pluginExtensions).toEqual({
    example: { draft: { text: "Saved operator draft", revisions: [2, 3] } },
  });
  expect(JSON.parse(String(legacy.readRaw()))).toMatchObject({
    sessionFile: "sqlite:main:session-legacy:/synthetic/sessions.json",
    transcriptPath: "retained-transcript-locator",
    archivedBy: { type: "human", id: "prior-archiver" },
  });
  closeOpenClawAgentDatabasesForTest();
  expect(loadExactSessionEntryReadOnly(legacy.scope)?.entry).toMatchObject({
    updatedAt: 42,
    label: "preserved label",
    skillsSnapshot: snapshot,
    pendingFinalDelivery: {
      kind: "replayable",
      text: "saved reply",
      createdAt: 40,
      context: { channel: "telegram", to: "synthetic-recipient", threadId: 3 },
      intentId: "intent-legacy",
    },
    fallbackNotice: {
      kind: "active",
      selectedModel: "openai/model-a",
      activeModel: "openai/model-b",
      reason: "rate-limit",
    },
    memoryFlush: { kind: "failed", compactionCount: 0, failureCount: 2 },
  });
  expect(loadExactSessionEntryReadOnly(transport.scope)?.entry.pendingFinalDelivery).toEqual({
    kind: "transport-only",
    createdAt: 42,
  });
  expect(loadExactSessionEntryReadOnly(current.scope)?.entry).toMatchObject({
    pendingFinalDelivery: canonicalPending,
    fallbackNotice: { kind: "active", selectedModel: "current-a", activeModel: "current-b" },
    memoryFlush: { kind: "succeeded", compactionCount: 7 },
  });
  const backups = fs
    .readdirSync(path.dirname(legacy.databasePath))
    .filter((name) =>
      name.startsWith(`${path.basename(legacy.databasePath)}.pre-startup-migration-`),
    );
  expect(backups).toHaveLength(1);
  using backup = new DatabaseSync(path.join(path.dirname(legacy.databasePath), backups[0]!), {
    readOnly: true,
  });
  expect(
    backup
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(legacy.sessionKey)?.entry_json,
  ).toBe(legacy.raw);
  expect(
    backup
      .prepare("SELECT value_json FROM session_entry_snapshots WHERE session_key = ?")
      .get(legacy.sessionKey)?.value_json,
  ).toBe(JSON.stringify(snapshot));
  expect(await repairLegacySessionEntryStates({ apply: true, cfg: {}, env: state.env })).toEqual({
    found: 0,
    repaired: 0,
    scannedStores: 1,
  });
});

it.each(["snapshot failure", "retired owner"] as const)(
  "does not rewrite rows after %s",
  async (failure) => {
    state = await createOpenClawTestState({
      prefix: "openclaw-doctor-entry-refusal-",
      scenario: "minimal",
    });
    const legacy = seedEntry("refused", {
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "must survive",
    });
    const createSnapshot = snapshots.createVerifiedSqliteSnapshot;
    let retired = false;
    vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementation(async (options) => {
      if (failure === "snapshot failure") {
        throw new Error("snapshot unavailable");
      }
      const result = await createSnapshot(options);
      retired = true;
      return result;
    });
    const refused = withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "session entry refusal test",
      run: (authority) =>
        repairLegacySessionEntryStates({
          apply: true,
          cfg: {},
          env: state!.env,
          authority: {
            assertCurrent() {
              authority.assertCurrent();
              if (retired) {
                throw new Error("repair owner retired");
              }
            },
          },
        }),
    });
    await expect(refused).rejects.toBeInstanceOf(DoctorStateMigrationRefusalError);
    await expect(refused).rejects.toThrow(
      failure === "snapshot failure" ? "snapshot unavailable" : "repair owner retired",
    );
    expect(legacy.readRaw()).toBe(legacy.raw);
    expect(() => loadExactSessionEntryReadOnly(legacy.scope)).toThrow(/run openclaw doctor --fix/);
  },
);

it("refuses a failed raw scan without treating its store as clean", async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-entry-scan-refusal-",
    scenario: "minimal",
  });
  const legacy = seedEntry("scan-failure", { pendingFinalDelivery: true });
  vi.spyOn(entryRepairs, "scanDoctorSessionEntryRecords").mockImplementationOnce(() => {
    throw new Error("synthetic database read failure");
  });
  await expect(
    repairLegacySessionEntryStates({ apply: false, cfg: {}, env: state.env }),
  ).rejects.toBeInstanceOf(DoctorStateMigrationRefusalError);
  expect(legacy.readRaw()).toBe(legacy.raw);
});

it("normalizes only scalar state while leaving malformed identity for its repair owner", async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-entry-malformed-refusal-",
    scenario: "minimal",
  });
  const legacy = seedEntry("malformed", { pendingFinalDelivery: true });
  const malformed =
    '{"pendingFinalDelivery":true,"displayName":"Retained title","opaqueCount":9007199254740993}';
  openOpenClawAgentDatabase({ agentId: "main", env: state.env })
    .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run(malformed, legacy.sessionKey);
  const report = await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "malformed session state test",
    run: (authority) =>
      repairLegacySessionEntryStates({ apply: true, cfg: {}, env: state!.env, authority }),
  });
  expect(report).toMatchObject({ found: 1, repaired: 1 });
  const repairedRaw = String(legacy.readRaw());
  const repairedEntry = JSON.parse(repairedRaw);
  expect(repairedEntry).toMatchObject({
    displayName: "Retained title",
    pendingFinalDelivery: { kind: "transport-only", createdAt: 42 },
  });
  expect(repairedEntry).not.toHaveProperty("sessionId");
  expect(repairedEntry).not.toHaveProperty("updatedAt");
  expect(repairedRaw).toContain('"opaqueCount":9007199254740993');
  expect(
    openOpenClawAgentDatabase({ agentId: "main", env: state.env })
      .db.prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
      .get(legacy.sessionKey)?.entry_valid,
  ).toBe(0);
  const backupName = fs
    .readdirSync(path.dirname(legacy.databasePath))
    .find((name) =>
      name.startsWith(`${path.basename(legacy.databasePath)}.pre-startup-migration-`),
    );
  expect(backupName).toBeDefined();
  using backup = new DatabaseSync(path.join(path.dirname(legacy.databasePath), backupName!), {
    readOnly: true,
  });
  expect(
    backup
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(legacy.sessionKey)?.entry_json,
  ).toBe(malformed);
});

it("refuses a database replaced during raw inspection even when its rows are identical", async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-entry-replacement-refusal-",
    scenario: "minimal",
  });
  const legacy = seedEntry("replacement", { pendingFinalDelivery: true });
  const replacementPath = `${legacy.databasePath}.replacement`;
  await snapshots.createVerifiedSqliteSnapshot({
    sourcePath: legacy.databasePath,
    targetPath: replacementPath,
    preserveRowIds: true,
  });
  const scan = entryRepairs.scanDoctorSessionEntryRecords;
  vi.spyOn(entryRepairs, "scanDoctorSessionEntryRecords").mockImplementationOnce((...args) => {
    scan(...args);
    closeOpenClawAgentDatabasesForTest();
    fs.renameSync(legacy.databasePath, `${legacy.databasePath}.original`);
    fs.renameSync(replacementPath, legacy.databasePath);
  });
  await expect(
    withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "replaced session state test",
      run: (authority) =>
        repairLegacySessionEntryStates({ apply: true, cfg: {}, env: state!.env, authority }),
    }),
  ).rejects.toBeInstanceOf(DoctorStateMigrationRefusalError);
  using replacement = new DatabaseSync(legacy.databasePath, { readOnly: true });
  expect(
    replacement
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(legacy.sessionKey)?.entry_json,
  ).toBe(legacy.raw);
});

it.each(["preparation", "native open"] as const)(
  "refuses a replacement during cold %s before changing its permissions, journal, or rows",
  async (boundary) => {
    state = await createOpenClawTestState({
      prefix: "openclaw-entry-cold-replacement-",
      scenario: "minimal",
    });
    const legacy = seedEntry("cold-replacement", { pendingFinalDelivery: true });
    const replacementPath = `${legacy.databasePath}.replacement`;
    await snapshots.createVerifiedSqliteSnapshot({
      sourcePath: legacy.databasePath,
      targetPath: replacementPath,
      preserveRowIds: true,
    });
    const expectedIdentity = readDatabasePathIdentitySync(legacy.databasePath);
    closeOpenClawAgentDatabasesForTest();
    {
      using replacement = new DatabaseSync(replacementPath);
      replacement.exec("PRAGMA journal_mode = DELETE");
    }
    const originalBytes = fs.readFileSync(replacementPath);
    fs.chmodSync(replacementPath, 0o644);
    const open = nodeSqlite.openNodeSqliteDatabase;
    let replaced = false;
    const replace = () => {
      replaced = true;
      fs.renameSync(legacy.databasePath, `${legacy.databasePath}.original`);
      fs.renameSync(replacementPath, legacy.databasePath);
    };
    if (boundary === "preparation") {
      const readQuarantine = quarantine.readOpenClawDatabaseQuarantineFailure;
      vi.spyOn(quarantine, "readOpenClawDatabaseQuarantineFailure").mockImplementation(
        (...args) => {
          if (args[0] === "agent" && args[1] === legacy.databasePath && !replaced) {
            replace();
          }
          return readQuarantine(...args);
        },
      );
    }
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
      if (
        (pathname === legacy.databasePath ||
          pathname === nodeSqlite.resolveExistingSqliteFileUri(legacy.databasePath)) &&
        !options?.readOnly &&
        !replaced
      ) {
        replace();
      }
      return open(pathname, options);
    });
    expect(() =>
      entryRepairs.rewriteDoctorSessionEntries({
        scope: legacy.scope,
        sessionKeys: [legacy.sessionKey],
        expectedIdentity,
        rawTransform: (entry) => ({
          ...entry,
          pendingFinalDelivery: { kind: "transport-only", createdAt: 42 },
        }),
      }),
    ).toThrow(
      boundary === "preparation"
        ? /SQLite database file identity changed before existing-only open/
        : /changed during repair admission/,
    );
    expect(replaced).toBe(true);
    expect(fs.readFileSync(legacy.databasePath)).toEqual(originalBytes);
    if (process.platform !== "win32") {
      expect(fs.statSync(legacy.databasePath).mode & 0o777).toBe(0o644);
    }
    using replacement = new DatabaseSync(legacy.databasePath, { readOnly: true });
    expect(replacement.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    expect(
      replacement
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(legacy.sessionKey)?.entry_json,
    ).toBe(legacy.raw);
  },
);

it("stops cold admission when the repair owner retires before native open returns", async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-entry-admission-authority-",
    scenario: "minimal",
  });
  const legacy = seedEntry("retired-admission", { pendingFinalDelivery: true });
  closeOpenClawAgentDatabasesForTest();
  {
    using database = new DatabaseSync(legacy.databasePath);
    database.exec("PRAGMA journal_mode = DELETE");
  }
  const expectedIdentity = readDatabasePathIdentitySync(legacy.databasePath);
  const originalBytes = fs.readFileSync(legacy.databasePath);
  let retired = false;
  const open = nodeSqlite.openNodeSqliteDatabase;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = open(pathname, options);
    if (pathname === nodeSqlite.resolveExistingSqliteFileUri(legacy.databasePath)) {
      retired = true;
    }
    return database;
  });
  expect(() =>
    entryRepairs.rewriteDoctorSessionEntries({
      scope: legacy.scope,
      sessionKeys: [legacy.sessionKey],
      expectedIdentity,
      assertCurrent: () => {
        if (retired) {
          throw new Error("repair owner retired during admission");
        }
      },
      rawTransform: (entry) => ({
        ...entry,
        pendingFinalDelivery: { kind: "transport-only", createdAt: 42 },
      }),
    }),
  ).toThrow("repair owner retired during admission");
  expect(retired).toBe(true);
  expect(fs.readFileSync(legacy.databasePath)).toEqual(originalBytes);
});

it("repairs published schema-v16 scalar rows after the Doctor schema owner upgrades them", async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  const databasePath = createLegacyDatabaseFixture({
    env: state.env,
    schemaVersion: 16,
    eventsBySession: { "old-scalar": [] },
  });
  const sessionKey = "agent:main:old-scalar";
  const raw = JSON.stringify({
    sessionId: "old-scalar",
    updatedAt: 1,
    delivery: { kind: "none" },
    pendingFinalDelivery: true,
    pendingFinalDeliveryText: "published pending reply",
    memoryFlushCompactionCount: 2,
  });
  {
    using database = new DatabaseSync(databasePath);
    database
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(raw, sessionKey);
  }
  const recovery = await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "inspect old session recovery",
    run: (authority) =>
      runDoctorSessionSqlite(
        { env: state!.env, cfg: {}, mode: "recover", store: databasePath },
        authority,
      ),
  });
  expect(recovery.totals.issues).toBeGreaterThan(0);
  const result = await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "old session entry state migration",
    run: () =>
      autoMigrateLegacyState({
        cfg: { plugins: { enabled: false } },
        env: state!.env,
        homedir: () => state!.home,
        doctorOnlyStateMigrations: true,
        invocationPurpose: "doctor",
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      }),
  });
  expect(result.stepReceipts.find((receipt) => receipt.id === "session-entry-state")).toMatchObject(
    {
      outcome: "completed",
    },
  );
  using repaired = new DatabaseSync(databasePath, { readOnly: true });
  expect(repaired.prepare("PRAGMA user_version").get()?.user_version).toBe(
    OPENCLAW_AGENT_SCHEMA_VERSION,
  );
  expect(
    loadExactSessionEntryReadOnly({ agentId: "main", env: state.env, sessionKey })?.entry,
  ).toMatchObject({
    sessionId: "old-scalar",
    pendingFinalDelivery: { kind: "replayable", text: "published pending reply", createdAt: 1 },
    memoryFlush: { kind: "succeeded", compactionCount: 2 },
  });
});

it("lets session recovery repair a corrupt index before scalar backup and normalization", async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  const legacy = seedEntry("recovered-scalar", { pendingFinalDelivery: true });
  openOpenClawAgentDatabase({ agentId: "main", env: state.env })
    .db.prepare(
      "INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at) VALUES ('doctor', 'index-original', '{}', 100, 1)",
    )
    .run();
  closeOpenClawAgentDatabasesForTest();
  corruptSqliteIndexKey(
    legacy.databasePath,
    "idx_agent_cache_expiry",
    "index-original",
    "index-damaged!",
  );
  const report = await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "recover legacy scalar rows",
    run: (authority) =>
      runDoctorSessionSqlite(
        {
          env: state!.env,
          cfg: {},
          mode: "recover",
          store: legacy.databasePath,
          agent: "main",
        },
        authority,
      ),
  });
  expect(report.totals.issues).toBe(0);
  expect(loadExactSessionEntryReadOnly(legacy.scope)?.entry.pendingFinalDelivery).toEqual({
    kind: "transport-only",
    createdAt: 42,
  });
  using repaired = new DatabaseSync(legacy.databasePath, { readOnly: true });
  expect(repaired.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
});

it("reports failed scalar backup for the selected recovered manifest target", async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  const legacy = seedEntry("manifest-scalar", { pendingFinalDelivery: true });
  const target = {
    agentId: "main",
    storePath: legacy.databasePath,
    sqlitePath: legacy.databasePath,
  };
  const run = createSessionSqliteMigrationRun(state.env, [target]);
  vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockRejectedValue(
    new Error("synthetic snapshot failure"),
  );
  const report = await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "recover scalar manifest target",
    run: (authority) =>
      runDoctorSessionSqlite(
        { env: state!.env, cfg: {}, mode: "recover", store: legacy.databasePath },
        authority,
      ),
  });
  expect(report.migrationRun?.manifestPath).toBe(run.manifestPath);
  expect(
    report.targets[0]?.issues.some((issue) => issue.message.includes("synthetic snapshot failure")),
  ).toBe(true);
  expect(legacy.readRaw()).toBe(legacy.raw);
});
