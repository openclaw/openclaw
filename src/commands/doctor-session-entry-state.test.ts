import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectBytesEqual } from "../../test/helpers/file-snapshots.js";
import { readSessionEntryCount } from "../config/sessions/session-accessor.sqlite-entry-inventory.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration-runtime.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { createSessionSqliteMigrationRun } from "../infra/session-sqlite-migration-manifest.js";
import type { SqlConnection } from "../infra/sql-connection.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import * as snapshotSource from "../infra/sqlite-snapshot-source.js";
import * as snapshots from "../infra/sqlite-snapshot.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import * as quarantine from "../state/openclaw-quarantine-store.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { repairLegacySessionEntryStates } from "./doctor-session-delivery-state.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  type DoctorSqliteMaintenanceAuthority,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";
import * as entryRepairs from "./doctor/shared/session-entry-rewrite.js";

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

function withMaintenance<T>(run: (authority: DoctorSqliteMaintenanceAuthority) => Promise<T> | T) {
  return withDoctorSqliteMaintenanceLock({ env: state.env, operation: "session entry test", run });
}

function repair(apply = true, authority?: DoctorSqliteMaintenanceAuthority) {
  return repairLegacySessionEntryStates({ apply, cfg: {}, env: state.env, authority });
}

const applyRepair = () => withMaintenance((authority) => repair(true, authority));
const agentDatabase = () => openOpenClawAgentDatabase({ agentId: "main", env: state.env });
const transportOnly = { kind: "transport-only", createdAt: 42 };

function readBackup(databasePath: string) {
  const directory = path.dirname(databasePath);
  const backups = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(`${path.basename(databasePath)}.pre-startup-migration-`));
  expect(backups).toHaveLength(1);
  return new DatabaseSync(path.join(directory, backups[0]!), { readOnly: true });
}

function recover(store: string, agent?: string) {
  return withMaintenance((authority) =>
    runDoctorSessionSqlite({ env: state.env, cfg: {}, mode: "recover", store, agent }, authority),
  );
}

function seedEntry(key: string, fields: Record<string, unknown>) {
  const env = state.env;
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
  const readStored = (connection: Pick<SqlConnection, "prepare">) =>
    connection.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?").get(sessionKey)
      ?.entry_json;
  const readRaw = () => {
    const current = openOpenClawAgentDatabase({ agentId: "main", env });
    return readStored(current.db);
  };
  return {
    raw,
    readRaw,
    readStored,
    read: () => JSON.parse(String(readRaw())),
    sessionKey,
    databasePath: database.path,
    scope: { agentId: "main", env, sessionKey, storePath: database.path },
    writeRaw: (value: string) =>
      agentDatabase()
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(value, sessionKey),
    row: (columns: string, table = "session_nodes") =>
      agentDatabase()
        .db.prepare(`SELECT ${columns} FROM ${table} WHERE session_key = ?`)
        .get(sessionKey),
  };
}

function rewrite(
  legacy: ReturnType<typeof seedEntry>,
  expectedIdentity: ReturnType<typeof readDatabasePathIdentitySync>,
  assertCurrent?: () => void,
) {
  return entryRepairs.rewriteDoctorSessionEntries({
    scope: legacy.scope,
    sessionKeys: [legacy.sessionKey],
    expectedIdentity,
    assertCurrent,
    rawTransform: (entry) => ({ entry: { ...entry, pendingFinalDelivery: transportOnly } }),
  });
}

function snapshotReplacement(legacy: ReturnType<typeof seedEntry>) {
  const targetPath = `${legacy.databasePath}.replacement`;
  return snapshots
    .createVerifiedSqliteSnapshot({
      sourcePath: legacy.databasePath,
      targetPath,
      preserveRowIds: true,
    })
    .then(() => targetPath);
}

it("backs up and retires terminal unmatched restart custody only in Doctor", async () => {
  const custody = {
    mainRestartRecovery: {
      cycleId: "old-cycle",
      revision: 1,
      chargedAttempts: 3,
      executionIdentity: { runId: "tombstone-run" },
      tombstone: { reason: "exhausted" },
    },
    restartRecoveryRuns: [{ runId: "different-run", lifecycleGeneration: "old-generation" }],
    restartRecoveryTerminalRunIds: ["different-terminal-run"],
    restartRecoveryForceSafeTools: true,
    activeWriterRunId: "different-writer",
    lifecycleRunId: "different-lifecycle",
  };
  const archived = seedEntry("terminal-unmatched", {
    ...custody,
    status: "failed",
    archivedAt: 1,
    archiveReason: "restart-recovery",
    archivedBy: { type: "human", id: "archiver" },
    pendingFinalDelivery: {
      kind: "replayable",
      createdAt: 1,
      text: "old final",
      context: { channel: "telegram", to: "synthetic-recipient" },
    },
  });
  const live = seedEntry("live-unmatched", {
    ...custody,
    status: "failed",
    activeWriterRunId: "live-writer",
  });
  const nonterminal = seedEntry("nonterminal-unmatched", { ...custody, status: "interrupted" });
  const notice = {
    createdAt: 1,
    context: { channel: "telegram", to: "synthetic-recipient" },
    intentId: "retained",
    state: "acknowledged",
  };
  const terminal = seedEntry("done-unmatched", {
    ...custody,
    status: "done",
    pendingDeliveryNotice: notice,
  });
  const matched = seedEntry("matched", {
    mainRestartRecovery: {
      cycleId: "matched-cycle",
      executionIdentity: { runId: "matched-run" },
      tombstone: { reason: "exhausted" },
    },
    restartRecoveryRuns: [{ runId: "matched-run" }],
    status: "failed",
  });
  const claim = claimAgentRunContext(
    "live-writer",
    { sessionKey: live.sessionKey },
    { trackOwner: true, ownsContext: true },
  );
  try {
    expect(await applyRepair()).toMatchObject({ found: 3, repaired: 3 });
    expect(live.readRaw()).toBe(live.raw);
  } finally {
    releaseAgentRunContext("live-writer", claim);
  }
  expect(matched.read()).toMatchObject({
    status: "interrupted",
    resumeAfterRestart: { queuedInputIds: [] },
  });
  expect(archived.read()).toEqual({
    sessionId: "session-terminal-unmatched",
    updatedAt: 42,
    delivery: { kind: "none" },
    status: "failed",
    archivedAt: 1,
    archiveReason: "restart-recovery",
    archivedBy: { type: "human", id: "archiver" },
    activeWriterRunId: "different-writer",
    lifecycleRunId: "different-lifecycle",
    lastRunError: expect.stringContaining("unknown outcome"),
  });
  expect(terminal.read()).toEqual({
    sessionId: "session-done-unmatched",
    updatedAt: 42,
    delivery: { kind: "none" },
    status: "done",
    pendingDeliveryNotice: notice,
    activeWriterRunId: "different-writer",
    lifecycleRunId: "different-lifecycle",
  });
  expect(nonterminal.readRaw()).toBe(nonterminal.raw);
  using backup = readBackup(archived.databasePath);
  expect(archived.readStored(backup)).toBe(archived.raw);
});

it("aggregates startup guidance for terminal unmatched custody without retiring it", async () => {
  const fields = {
    status: "failed",
    mainRestartRecovery: { cycleId: "old", tombstone: { reason: "exhausted" } },
    restartRecoveryTerminalRunIds: ["unmatched"],
  };
  const first = seedEntry("startup-first", {
    ...fields,
    pendingFinalDelivery: true,
    pendingFinalDeliveryText: "Unsent final",
  });
  const second = seedEntry("startup-second", fields);
  const warnings: string[] = [];
  await runSessionStartupMigration({
    cfg: {},
    env: state.env,
    log: { info: () => {}, warn: (message) => warnings.push(message) },
  });
  expect(warnings).toEqual([expect.stringMatching(/main.*2.*openclaw doctor --fix/)]);
  expect(first.read()).toEqual({
    ...fields,
    sessionId: "session-startup-first",
    updatedAt: 42,
    delivery: { kind: "none" },
    pendingFinalDelivery: { kind: "replayable", text: "Unsent final", createdAt: 42 },
  });
  expect(second.readRaw()).toBe(second.raw);
});

it("closes a captured session inspection reader before removing its private snapshot", async () => {
  const legacy = seedEntry("captured-inspection", { pendingFinalDelivery: true });
  closeOpenClawAgentDatabasesForTest();
  const originalBytes = fs.readFileSync(legacy.databasePath);
  const generations = readUpdateDatabaseGenerations([legacy.databasePath]);
  const warnings: string[] = [];
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env: state.env,
    signal: new AbortController().signal,
    warn: (message) => warnings.push(message),
  })!;
  let snapshot: ReturnType<typeof snapshotSource.prepareSqliteReadOnlyLocationSync> | undefined;
  let reader: DatabaseSync | undefined;
  const openAtCleanup: boolean[] = [];
  const prepare = snapshotSource.prepareSqliteReadOnlyLocationSync;
  vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocationSync").mockImplementation((...args) => {
    snapshot = prepare(...args);
    const prepared = snapshot;
    return {
      ...prepared,
      cleanup() {
        openAtCleanup.push(reader?.isOpen ?? true);
        return prepared.cleanup();
      },
    };
  });
  const open = nodeSqlite.openNodeSqliteDatabase;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === snapshot?.location) {
      reader = database;
    }
    return database;
  });
  await withMaintenance(async (authority) => {
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => authority.assertCurrent(),
    });
    try {
      await capture.admit();
      const result = await scope.run(() => capture.run(() => repair(false, authority)));
      expect(result).toMatchObject({ found: 1, repaired: 0, scannedStores: 1 });
      expect(reader).toBeDefined();
      expect(openAtCleanup).toEqual([false]);
      expect(fs.existsSync(snapshot!.cleanupRoot!)).toBe(false);
      await capture.settle();
      expect(capture.receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
      expect(warnings).toEqual([]);
      expectBytesEqual(fs.readFileSync(legacy.databasePath), originalBytes, "inspected database");
    } finally {
      await scope.close();
      snapshot?.cleanup();
    }
  });
});

it("backs up original rows and migrates pending delivery state before canonical reads", async () => {
  const originalRows: ReturnType<typeof seedEntry>[] = [];
  const seed = (key: string, fields: Record<string, unknown>) => {
    const row = seedEntry(key, fields);
    originalRows.push(row);
    return row;
  };
  const numeric = seed("numeric-only", {
    spawnDepth: "2",
    inputTokens: "32",
    runtimeMs: "0",
    estimatedCostUsd: "0.25",
    createdAt: "10",
    pinnedAt: "20",
    archivedAt: "30",
    lastReadAt: "40",
    lastInteractionAt: "50",
    lastActivityAt: "60",
    startedAt: "70",
    endedAt: "80",
    pluginExtensions: { example: { draft: { text: "retained draft" } } },
  });
  const retained = {
    label: "preserved label",
    pluginExtensions: { example: { draft: { text: "Saved operator draft", revisions: [2, 3] } } },
    sessionFile: "sqlite:main:session-legacy:/synthetic/sessions.json",
    transcriptPath: "retained-transcript-locator",
    archivedBy: { type: "human", id: "prior-archiver" },
  };
  const legacy = seed("legacy", {
    ...retained,
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
  });
  const transport = seed("transport", { pendingFinalDelivery: true });
  const cleared = seed("cleared", { pendingFinalDelivery: false });
  const nullLegacyField = seed("null-legacy-field", { memoryFlushAt: null });
  const routing = seed("routing", {
    delivery: undefined,
    provider: "slack",
    lastProvider: "telegram",
    lastTo: "synthetic-recipient",
    lastAccountId: "work",
    room: "opaque alias",
    groupChannel: "#canonical",
  });
  const canonicalPending = {
    kind: "replayable",
    text: "current reply",
    createdAt: 39,
    intentId: "current-intent",
    deliveries: [{ id: "delivery-current", state: "queued" }],
  };
  const current = seed("current", {
    pendingFinalDelivery: { ...canonicalPending, artifactHint: "preserve opaque state metadata" },
    pendingFinalDeliveryText: "superseded reply",
    fallbackNotice: { kind: "active", selectedModel: "current-a", activeModel: "current-b" },
    fallbackNoticeSelectedModel: "old-a",
    fallbackNoticeActiveModel: "old-b",
    memoryFlush: { kind: "succeeded", compactionCount: 7 },
    memoryFlushCompactionCount: 1,
    memoryFlushFailureCount: 2,
  });
  const unchanged = seed("unchanged", {
    status: "done",
    pendingFinalDelivery: canonicalPending,
    provider: "opaque provider",
    lastProvider: "opaque last provider",
  });
  const recoveryClaims = {
    mainRestartRecovery: { foregroundClaims: [{ runId: "claimed-run" }] },
    restartRecoveryRuns: [{ runId: "claimed-run", sessionId: "recovery-session" }],
    restartRecoveryBeforeAgentReplyState: "pending",
    restartRecoveryDeliveryReceiptState: "terminal-pending",
  };
  const running = seed("running", { status: "running", endedAt: 40, ...recoveryClaims });
  const queued = seed("queued", { status: "queued", endedAt: -1 });
  const db = agentDatabase();
  const snapshot = { prompt: "retained snapshot", skills: [] };
  db.db
    .prepare(
      "INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (?, 'skillsSnapshot', ?)",
    )
    .run(legacy.sessionKey, JSON.stringify(snapshot));

  expect(() => loadExactSessionEntryReadOnly(legacy.scope)).toThrow(/run openclaw doctor --fix/);
  expect(() => loadExactSessionEntryReadOnly(routing.scope)).toThrow(/run openclaw doctor --fix/);
  expect(await repair(false)).toEqual({ found: 9, repaired: 0, scannedStores: 1 });
  expect(numeric.readRaw()).toBe(numeric.raw);
  expect(legacy.readRaw()).toBe(legacy.raw);
  expect(await applyRepair()).toMatchObject({ found: 9, repaired: 9 });
  for (const [legacyRun, endedAt] of [
    [running, 40],
    [queued, 42],
  ] as const) {
    expect(legacyRun.read()).toMatchObject({
      status: "killed",
      abortedLastRun: true,
      suppressErrorNotice: true,
      endedAt,
      updatedAt: 42,
    });
    expect(legacyRun.read()).not.toHaveProperty("lastRunError");
    expect(legacyRun.read()).not.toHaveProperty("resumeAfterRestart");
    expect(legacyRun.row("status")).toEqual({ status: "killed" });
    expect(legacyRun.row("status, ended_at", "session_windows")).toEqual({
      status: "killed",
      ended_at: endedAt,
    });
  }
  expect(running.read()).toMatchObject(recoveryClaims);
  expect(routing.read()).toMatchObject({
    delivery: { kind: "external", context: { channel: "telegram", accountId: "work" } },
    room: "opaque alias",
    groupChannel: "#canonical",
  });
  expect(routing.read()).not.toHaveProperty("provider");
  expect(routing.read()).not.toHaveProperty("lastProvider");
  expect(routing.row("channel, account_id", "session_windows")).toMatchObject({
    channel: "telegram",
    account_id: "work",
  });
  expect(cleared.read()).not.toHaveProperty("pendingFinalDelivery");
  expect(nullLegacyField.read()).not.toHaveProperty("memoryFlushAt");
  expect(unchanged.readRaw()).toBe(unchanged.raw);
  expect(current.read().pendingFinalDelivery).toEqual({
    ...canonicalPending,
    artifactHint: "preserve opaque state metadata",
  });
  expect(legacy.readRaw()).not.toContain("pendingFinalDeliveryText");
  expect(legacy.read().pluginExtensions).toEqual(retained.pluginExtensions);
  expect(legacy.read()).toMatchObject(retained);
  closeOpenClawAgentDatabasesForTest();
  const entry = loadExactSessionEntryReadOnly(numeric.scope)?.entry;
  expect(entry).toMatchObject({
    spawnDepth: 2,
    inputTokens: 32,
    runtimeMs: 0,
    estimatedCostUsd: 0.25,
    pluginExtensions: { example: { draft: { text: "retained draft" } } },
  });
  expect((entry?.spawnDepth ?? 0) + 1).toBe(3);
  expect(
    readSessionEntryCount(agentDatabase(), { includeArchived: true }) -
      readSessionEntryCount(agentDatabase(), { includeArchived: false }),
  ).toBe(1);
  expect(
    numeric.row(
      "created_at, pinned_at, archived_at, last_read_at, last_interaction_at, last_activity_at",
    ),
  ).toEqual({
    created_at: 10,
    pinned_at: 20,
    archived_at: 30,
    last_read_at: 40,
    last_interaction_at: 50,
    last_activity_at: 60,
  });
  expect(numeric.row("started_at, ended_at", "session_windows")).toEqual({
    started_at: 70,
    ended_at: 80,
  });
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
  expect(loadExactSessionEntryReadOnly(transport.scope)?.entry.pendingFinalDelivery).toEqual(
    transportOnly,
  );
  const currentEntry = loadExactSessionEntryReadOnly(current.scope)?.entry;
  expect(currentEntry?.pendingFinalDelivery).toEqual(canonicalPending);
  expect(currentEntry).toMatchObject({
    fallbackNotice: { kind: "active", selectedModel: "current-a", activeModel: "current-b" },
    memoryFlush: { kind: "succeeded", compactionCount: 7 },
  });
  using backup = readBackup(legacy.databasePath);
  for (const legacyRun of originalRows) {
    expect(legacyRun.readStored(backup)).toBe(legacyRun.raw);
  }
  expect(
    backup
      .prepare("SELECT value_json FROM session_entry_snapshots WHERE session_key = ?")
      .get(legacy.sessionKey)?.value_json,
  ).toBe(JSON.stringify(snapshot));
  expect(await repair()).toEqual({ found: 0, repaired: 0, scannedStores: 1 });
});

it.each([false, true])(
  "refuses retired room grouping before any row repair (apply: %s)",
  async (apply) => {
    const supported = seedEntry("a-supported", { memoryFlushCompactionCount: 0 });
    const retired = seedEntry("retired", { room: "#legacy" });
    const canonical = seedEntry("canonical", { room: "opaque", groupChannel: "#current" });
    const raw = `${retired.raw.slice(0, -1)}, "groupChannel":"ignored", "groupChannel":null }`;
    retired.writeRaw(raw);
    expect(() => loadExactSessionEntryReadOnly(retired.scope)).toThrow(/2026\.9\.5/);
    expect(loadExactSessionEntryReadOnly(canonical.scope)?.entry).toMatchObject({
      groupChannel: "#current",
    });
    await expect(
      repairLegacySessionEntryStates({ apply, cfg: {}, env: state.env }),
    ).rejects.toThrow(/2026\.9\.5/);
    expect(retired.readRaw()).toBe(raw);
    expect(supported.readRaw()).toBe(supported.raw);
    expect(canonical.readRaw()).toBe(canonical.raw);
  },
);

it.each(["snapshot failure", "retired owner", "retired room introduced after scan"] as const)(
  "does not rewrite rows after %s",
  async (failure) => {
    const legacy = seedEntry("refused", {
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "must survive",
    });
    const createSnapshot = snapshots.createVerifiedSqliteSnapshot;
    let retired = false;
    let expectedRaw = legacy.raw;
    vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementation(async (options) => {
      if (failure === "snapshot failure") {
        throw new Error("snapshot unavailable");
      }
      const result = await createSnapshot(options);
      if (failure === "retired owner") {
        retired = true;
      } else {
        expectedRaw = JSON.stringify({ ...JSON.parse(legacy.raw), room: "#legacy" });
        using database = new DatabaseSync(legacy.databasePath);
        database
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(expectedRaw, legacy.sessionKey);
      }
      return result;
    });
    const refused = withMaintenance((authority) =>
      repairLegacySessionEntryStates({
        apply: true,
        cfg: {},
        env: state.env,
        authority: {
          assertCurrent() {
            authority.assertCurrent();
            if (retired) {
              throw new Error("repair owner retired");
            }
          },
        },
      }),
    );
    await expect(refused).rejects.toBeInstanceOf(DoctorStateMigrationRefusalError);
    await expect(refused).rejects.toThrow(
      failure === "snapshot failure"
        ? "snapshot unavailable"
        : failure === "retired owner"
          ? "repair owner retired"
          : "2026.9.5",
    );
    expect(legacy.readRaw()).toBe(expectedRaw);
    expect(() => loadExactSessionEntryReadOnly(legacy.scope)).toThrow(/openclaw doctor --fix/);
  },
);

it.each([false, true])(
  "refuses a failed raw scan with schema deferral %s",
  async (deferSchemaRepair) => {
    const legacy = seedEntry("scan-failure", { pendingFinalDelivery: true });
    vi.spyOn(entryRepairs, "scanDoctorSessionEntryRecords").mockImplementationOnce(() => {
      throw new Error("synthetic database read failure");
    });
    await expect(
      repairLegacySessionEntryStates({ apply: false, cfg: {}, env: state.env, deferSchemaRepair }),
    ).rejects.toBeInstanceOf(DoctorStateMigrationRefusalError);
    expect(legacy.readRaw()).toBe(legacy.raw);
  },
);

it("normalizes only scalar state while leaving malformed identity for its repair owner", async () => {
  const legacy = seedEntry("malformed", { pendingFinalDelivery: true });
  const malformed =
    '{"pendingFinalDelivery":true,"displayName":"Retained title","opaqueCount":9007199254740993}';
  legacy.writeRaw(malformed);
  const report = await applyRepair();
  expect(report).toMatchObject({ found: 1, repaired: 1 });
  const repairedRaw = String(legacy.readRaw());
  const repairedEntry = JSON.parse(repairedRaw);
  expect(repairedEntry).toMatchObject({
    displayName: "Retained title",
    pendingFinalDelivery: transportOnly,
  });
  expect(repairedEntry).not.toHaveProperty("sessionId");
  expect(repairedEntry).not.toHaveProperty("updatedAt");
  expect(repairedRaw).toContain('"opaqueCount":9007199254740993');
  expect(legacy.row("entry_valid")).toEqual({ entry_valid: 0 });
  using backup = readBackup(legacy.databasePath);
  expect(legacy.readStored(backup)).toBe(malformed);
});

it("refuses a database replaced during raw inspection even when its rows are identical", async () => {
  const legacy = seedEntry("replacement", { pendingFinalDelivery: true });
  const replacementPath = await snapshotReplacement(legacy);
  const scan = entryRepairs.scanDoctorSessionEntryRecords;
  vi.spyOn(entryRepairs, "scanDoctorSessionEntryRecords").mockImplementationOnce((...args) => {
    scan(...args);
    closeOpenClawAgentDatabasesForTest();
    fs.renameSync(legacy.databasePath, `${legacy.databasePath}.original`);
    fs.renameSync(replacementPath, legacy.databasePath);
  });
  await expect(applyRepair()).rejects.toBeInstanceOf(DoctorStateMigrationRefusalError);
  using replacement = new DatabaseSync(legacy.databasePath, { readOnly: true });
  expect(legacy.readStored(replacement)).toBe(legacy.raw);
});

it.each(["preparation", "native open"] as const)(
  "refuses a replacement during cold %s before changing its permissions, journal, or rows",
  async (boundary) => {
    const legacy = seedEntry("cold-replacement", { pendingFinalDelivery: true });
    const replacementPath = await snapshotReplacement(legacy);
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
    expect(() => rewrite(legacy, expectedIdentity)).toThrow(
      boundary === "preparation"
        ? /SQLite database file identity changed before existing-only open/
        : /changed during repair admission/,
    );
    expect(replaced).toBe(true);
    expectBytesEqual(fs.readFileSync(legacy.databasePath), originalBytes, "replacement database");
    if (process.platform !== "win32") {
      expect(fs.statSync(legacy.databasePath).mode & 0o777).toBe(0o644);
    }
    using replacement = new DatabaseSync(legacy.databasePath, { readOnly: true });
    expect(replacement.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    expect(legacy.readStored(replacement)).toBe(legacy.raw);
  },
);

it("stops cold admission when the repair owner retires before native open returns", async () => {
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
    rewrite(legacy, expectedIdentity, () => {
      if (retired) {
        throw new Error("repair owner retired during admission");
      }
    }),
  ).toThrow("repair owner retired during admission");
  expect(retired).toBe(true);
  expectBytesEqual(
    fs.readFileSync(legacy.databasePath),
    originalBytes,
    "retired admission database",
  );
});

it("reuses inspected raw targets while preserving deferred schema repair", async () => {
  const currentPath = seedEntry("current", {}).databasePath;
  const deferredPath = createLegacyDatabaseFixture({
    agentId: "deferred",
    env: state.env,
    schemaVersion: 16,
    eventsBySession: { deferred: [] },
  });
  const inspectedPaths: string[] = [];
  const result = await withMaintenance(() =>
    repairLegacySessionEntryStates({
      apply: false,
      cfg: {},
      env: state.env,
      deferSchemaRepair: true,
      targets: [
        { agentId: "main", storePath: currentPath, sqlitePath: currentPath },
        { agentId: "deferred", storePath: deferredPath, sqlitePath: deferredPath },
      ],
      onInspectedTargets: (targets) => {
        inspectedPaths.push(...targets.map((target) => target.sqlitePath));
      },
    }),
  );
  expect(result).toEqual({ found: 0, repaired: 0, scannedStores: 2 });
  expect(inspectedPaths).toEqual([currentPath]);
  const scan = vi.spyOn(entryRepairs, "scanDoctorSessionEntryRecords");
  await withMaintenance(() =>
    autoMigrateLegacyState({
      cfg: { plugins: { enabled: false } },
      env: state.env,
      homedir: () => state.home,
      doctorOnlyStateMigrations: true,
      invocationPurpose: "doctor",
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      inspectedSessionEntryPaths: inspectedPaths,
    }),
  );
  const scannedPaths = scan.mock.calls.map(([scope]) => scope.storePath);
  expect(scannedPaths).not.toContain(currentPath);
  expect(scannedPaths).toContain(deferredPath);
});

it("repairs published schema-v16 scalar rows after the Doctor schema owner upgrades them", async () => {
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
  const recovery = await recover(databasePath);
  expect(recovery.totals.issues).toBeGreaterThan(0);
  const result = await withMaintenance(() =>
    autoMigrateLegacyState({
      cfg: { plugins: { enabled: false } },
      env: state.env,
      homedir: () => state.home,
      doctorOnlyStateMigrations: true,
      invocationPurpose: "doctor",
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    }),
  );
  expect(
    result.stepReceipts
      .filter((receipt) =>
        ["session-entry-state-preparation", "media-persistence", "session-entry-state"].includes(
          receipt.id,
        ),
      )
      .map((receipt) => [receipt.id, receipt.outcome]),
  ).toEqual([
    ["session-entry-state-preparation", "skipped"],
    ["media-persistence", "completed"],
    ["session-entry-state", "completed"],
  ]);
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
  const legacy = seedEntry("recovered-scalar", { pendingFinalDelivery: true });
  agentDatabase()
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
  const report = await recover(legacy.databasePath, "main");
  expect(report.totals.issues).toBe(0);
  expect(loadExactSessionEntryReadOnly(legacy.scope)?.entry.pendingFinalDelivery).toEqual(
    transportOnly,
  );
  using repaired = new DatabaseSync(legacy.databasePath, { readOnly: true });
  expect(repaired.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
});

it("reports failed scalar backup for the selected recovered manifest target", async () => {
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
  const report = await recover(legacy.databasePath);
  expect(report.migrationRun?.manifestPath).toBe(run.manifestPath);
  expect(
    report.targets[0]?.issues.some((issue) => issue.message.includes("synthetic snapshot failure")),
  ).toBe(true);
  expect(legacy.readRaw()).toBe(legacy.raw);
});
