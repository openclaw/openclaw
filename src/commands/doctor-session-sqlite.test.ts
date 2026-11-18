import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  loadExactSessionEntry as readEntry,
  upsertSessionEntryCore as upsertEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  loadTranscriptEventsSync as readEvents,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest as closeDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { sessionDeliveryRoute } from "../utils/delivery-context.read.js";
import {
  writeJson,
  sessionScope,
  runStoreDoctor,
  archivedSource,
  retireRecovery,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  expectMissing,
  expectFiles,
  snapshotFiles,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";
import {
  importLegacyStore,
  readMigrationManifest as readManifest,
  useDoctorSessionSqliteTestFixture,
  type TestStore,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

async function importSession(store: TestStore) {
  const report = await importLegacyStore(store);
  expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
  const scope = sessionScope(store);
  return { report, scope, entry: readEntry(scope)?.entry };
}

it.each([" session-1 ", "agent:main:main"])(
  "imports legacy pending delivery state without changing identity %j",
  async (sessionId) => {
    const store = createLegacyStore({
      entryOverrides: {
        sessionId,
        initializationPending: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "saved reply",
        pendingFinalDeliveryCreatedAt: 1000,
        pendingFinalDeliveryContext: { channel: "telegram", to: "synthetic-recipient" },
        pendingFinalDeliveryIntentId: "legacy-intent",
        pendingFinalDeliveryAttemptCount: 2,
        pendingFinalDeliveryLastAttemptAt: 1500,
        pendingFinalDeliveryLastError: "old failure",
      },
      transcriptLines: [
        JSON.stringify({ type: "session", version: 3, id: sessionId }),
        '{"type":"event","id":"evt-1"}',
      ],
    });
    const originalStore = fs.readFileSync(store.storePath, "utf8");

    const { report, entry: imported } = await importSession(store);
    expect(report.totals.importedTranscriptEvents).toBe(2);
    expect(imported).toMatchObject({
      sessionId,
      pendingFinalDelivery: {
        kind: "replayable",
        text: "saved reply",
        createdAt: 1000,
        context: { channel: "telegram", to: "synthetic-recipient" },
        intentId: "legacy-intent",
      },
    });
    expect(imported).not.toHaveProperty("pendingFinalDeliveryText");
    expect(imported).not.toHaveProperty("pendingFinalDeliveryAttemptCount");
    expectFiles(originalStore, archivedSource(report, store.storePath).archivePath);
  },
);

it.each([
  {
    name: "July provider fallback",
    entryOverrides: {
      channel: undefined,
      lastChannel: undefined,
      provider: "telegram",
      lastTo: "123",
      lastAccountId: "work",
    },
    context: { channel: "telegram", to: "123", accountId: "work" },
    expected: {},
  },
  {
    name: "July channel precedence and mutation watermark",
    entryOverrides: {
      channel: "telegram",
      groupChannel: "July group",
      lastChannel: "telegram",
      lastTo: "123",
      provider: "stale-provider",
      lastProvider: "stale-last-provider",
      room: "stale-room",
    },
    context: { channel: "telegram", to: "123" },
    expected: { groupChannel: "July group" },
    transcriptLines: [
      '{"type":"session","version":3,"id":"session-1","timestamp":"2026-07-01T23:00:00.000Z","cwd":"/fixture"}',
      '{"type":"message","id":"july-message","parentId":null,"message":{"role":"user","content":"July history"}}',
    ],
  },
])(
  "imports $name and archives original source bytes",
  async ({ entryOverrides, expected, context, transcriptLines }) => {
    const store = createLegacyStore({ entryOverrides, transcriptLines });
    const mtime = new Date(1_700_000_000_000);
    fs.utimesSync(store.transcriptPath, mtime, mtime);
    const originals = snapshotFiles([store.storePath, store.transcriptPath]);
    const { report, scope, entry: imported } = await importSession(store);
    expect(imported).toMatchObject({ ...expected, delivery: { kind: "external", context } });
    if (!transcriptLines) {
      expect(imported).not.toHaveProperty("provider");
    } else {
      expect(readTranscriptStatsSync(scope).lastMutationAtMs).toBe(mtime.getTime());
      expect(readEvents(scope)[1]).toMatchObject({
        id: "july-message",
        message: { content: "July history" },
      });
    }
    for (const { file, bytes } of originals) {
      expectFiles(bytes, archivedSource(report, file).archivePath);
    }
  },
);

it("repairs legacy transcript and route shapes at the import boundary", async () => {
  const store = createLegacyStore({
    entryOverrides: {
      route: "stale-custom-slot",
      deliveryContext: { channel: "telegram", to: "123" },
    },
    transcriptLines: [
      '{"type":"session","sessionId":"session-1"}',
      '{"type":"plugin_state","id":"opaque-1","payload":{"keep":"exact"}}',
      '{"type":"message","id":"m1","parentId":null,"message":{"role":"assistant","content":"legacy string"}}',
      '{"type":"compaction","summary":"legacy summary","firstKeptEntryIndex":2,"tokensBefore":42}',
    ],
  });

  const { scope, entry: imported } = await importSession(store);
  // The SQLite runtime does no read repair, so import must store canonical shapes.
  expect(typeof sessionDeliveryRoute(imported)).not.toBe("string");
  const events = readEvents(scope);
  const message = events[2];
  assert(isRecord(message) && typeof message.id === "string");
  expect(events.slice(0, 4)).toMatchObject([
    { id: "session-1", type: "session", version: 3 },
    {},
    { message: { content: [{ type: "text", text: "legacy string" }] } },
    { firstKeptEntryId: message.id, parentId: message.id },
  ]);
  expect(events[0]).not.toHaveProperty("sessionId");
  expect(events[1]).toEqual({ id: "opaque-1", payload: { keep: "exact" }, type: "plugin_state" });
  const manager = SessionManager.open(scope, store.tempDir);
  expect(manager.appendMessage({ content: "post-import", role: "user", timestamp: 1000 })).toEqual(
    expect.any(String),
  );
  closeDatabases();
  const migrated = openNodeSqliteDatabase(resolveOpenClawAgentSqlitePath(scope), {
    readOnly: true,
  });
  try {
    const sql = sessionSqlFixture(migrated);
    expect(sql`PRAGMA user_version`.get()).toEqual({ user_version: OPENCLAW_AGENT_SCHEMA_VERSION });
    expect(
      sql`SELECT session_id, length(generation) AS generation_length FROM transcript_rewrite_watermarks`.all(),
    ).toEqual([{ generation_length: 32, session_id: "session-1" }]);
  } finally {
    migrated.close();
  }
});

it("aborts a batch when a prepared transcript changes before import", async () => {
  const store = createLegacyStore();
  const realStatSync = fs.statSync.bind(fs);
  let changed = false;
  const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((candidate, options) => {
    const stat = realStatSync(candidate, options as never);
    if (
      !changed &&
      path.resolve(String(candidate)) === path.resolve(store.transcriptPath) &&
      !(options as { bigint?: boolean } | undefined)?.bigint
    ) {
      changed = true;
      fs.appendFileSync(store.transcriptPath, '{"type":"custom","customType":"late"}\n');
    }
    return stat;
  }) as typeof fs.statSync);

  try {
    await expect(importLegacyStore(store)).rejects.toThrow(
      /stop active session writers and rerun `openclaw doctor --fix`/,
    );
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
  } finally {
    statSpy.mockRestore();
  }
});

it.each([
  {
    name: "same-generation harness ownership",
    legacy: { lifecycleRevision: "rev-1" },
    canonical: { agentHarnessId: "codex", lifecycleRevision: "rev-1" },
  },
  {
    name: "required creation provenance",
    legacy: {
      createdActor: { id: "profile-legacy", type: "human" },
      createdAt: 1000,
      createdVia: "channel",
    },
    canonical: {
      createdActor: { id: "profile-protected", type: "human", source: "profile" },
      createdAt: 1500,
      createdVia: "operator",
      sandbox: "required",
    } as const,
  },
])("preserves canonical $name during legacy import", async ({ legacy, canonical }) => {
  const store = createLegacyStore({ entryOverrides: legacy });
  await upsertEntry(sessionScope(store), {
    ...canonical,
    sessionId: "session-1",
    updatedAt: 3000,
  });
  const { entry } = await importSession(store);
  expect(entry).toMatchObject({ ...canonical, sessionId: "session-1" });
});

it("archives legacy stores with valid sessions and invalid cron stubs without failing", async () => {
  const store = createLegacyStore();
  const legacyStore: Record<string, unknown> = JSON.parse(
    fs.readFileSync(store.storePath, "utf-8"),
  );
  const cronStubKey = "agent:main:cron:legacy-stub";
  legacyStore[cronStubKey] = { updatedAt: 1500 };
  writeJson(store.storePath, legacyStore, 2);

  const report = await importLegacyStore(store);

  expect(report.totals).toMatchObject({
    archivedLegacyStoreFiles: 1,
    importedEntries: 1,
    importedTranscriptEvents: 2,
    issues: 1,
    sqliteEntries: 1,
  });
  expect(report.targets[0]?.issues).toEqual([
    {
      code: "entry_invalid",
      message: expect.stringContaining(
        `${store.storePath}: session entry is missing a valid sessionId`,
      ),
      sessionKey: cronStubKey,
    },
  ]);
  const archivedStorePath = archivedSource(report, store.storePath).archivePath;
  expectMissing(store.storePath);
  expect(JSON.parse(fs.readFileSync(archivedStorePath, "utf-8"))).toMatchObject({
    [cronStubKey]: { updatedAt: 1500 },
  });

  const manifest = readManifest(report.migrationRun?.manifestPath);
  expect([manifest.failedAt, manifest.failureReports]).toEqual([undefined, undefined]);
  expect(manifest.targets[0]).toMatchObject({
    issues: [expect.objectContaining({ code: "entry_invalid", sessionKey: cronStubKey })],
    validationBeforeArchive: "passed",
  });
  expect(report.migrationRun?.failureReportJsonPath).toBeUndefined();
  expect(report.migrationRun?.failureReportMarkdownPath).toBeUndefined();
  expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(true);
  expect(
    manifest.targets[0]!.completedMoves.every(
      (move) => move.artifact?.classification === "protected",
    ),
  ).toBe(true);
  closeDatabases();
  const cleanup = await retireRecovery(store);
  expect(cleanup.totals.removedFiles).toBe(0);
  expect(fs.existsSync(archivedStorePath)).toBe(true);
});

it("does not report SQLite markers as missing transcript files", async () => {
  const store = createLegacyStore();
  fs.rmSync(store.transcriptPath);
  fs.rmSync(store.trajectoryPath);
  const entries = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
  entries["agent:main:main"].sessionFile = `sqlite:main:session-1:${store.storePath}`;
  writeJson(store.storePath, entries, 2);

  const report = await importLegacyStore(store);
  const validation = await runStoreDoctor(store, "validate");

  expect(report.totals).toMatchObject({
    importedEntries: 1,
    importedTranscriptEvents: 0,
    issues: 0,
    sqliteEntries: 1,
  });
  expect(validation.totals).toMatchObject({
    issues: 0,
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
  });
  expect(readEntry(sessionScope(store))?.entry).not.toHaveProperty("sessionFile");
});
