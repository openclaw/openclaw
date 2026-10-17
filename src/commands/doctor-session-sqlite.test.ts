import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  loadExactSessionEntry as readEntry,
  upsertSessionEntryCore as upsertEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  loadTranscriptEventsSync as readEvents,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.sqlite-read.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest as closeDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { sessionDeliveryRoute } from "../utils/delivery-context.read.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import {
  writePrivateFile,
  writeJson,
  sessionScope,
  runStoreDoctor,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  expectMissing,
  expectFiles,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  importLegacyStore,
  readMigrationManifest as readManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
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

      const report = await importLegacyStore(store);

      expect(report.totals).toMatchObject({
        importedEntries: 1,
        importedTranscriptEvents: 2,
        issues: 0,
      });
      const imported = readEntry(sessionScope(store))?.entry;
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
      const archivedStore = expectDefined(
        report.targets[0]?.archivedLegacyStoreFiles?.[0],
        "archived legacy store",
      );
      expectFiles(originalStore, archivedStore);
    },
  );

  it("imports supported July provider routing and archives original source bytes", async () => {
    const store = createLegacyStore({
      entryOverrides: {
        channel: undefined,
        lastChannel: undefined,
        provider: "telegram",
        lastTo: "123",
        lastAccountId: "work",
      },
    });
    const originalStore = fs.readFileSync(store.storePath, "utf8");
    const originalTranscript = fs.readFileSync(store.transcriptPath, "utf8");

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    const imported = readEntry(sessionScope(store))?.entry;
    expect(imported).toMatchObject({
      delivery: {
        kind: "external",
        context: { channel: "telegram", to: "123", accountId: "work" },
      },
    });
    expect(imported).not.toHaveProperty("provider");
    const manifest = readManifest(report.migrationRun?.manifestPath);
    const target = expectDefined(manifest.targets[0], "imported target");
    for (const [kind, original] of [
      ["legacy-store", originalStore],
      ["transcript", originalTranscript],
    ] as const) {
      const archived = expectDefined(
        target.completedMoves.find((move) => move.kind === kind),
        `archived ${kind}`,
      );
      expectFiles(original, archived.archivePath);
    }
  });

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

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    const imported = readEntry(sessionScope(store));
    // The SQLite runtime does no read repair, so import must store canonical shapes.
    expect(typeof sessionDeliveryRoute(imported?.entry)).not.toBe("string");
    const events = readEvents(sessionScope(store));
    const message = events[2];
    assert(
      message !== null &&
        typeof message === "object" &&
        "id" in message &&
        typeof message.id === "string",
    );
    expect(events.slice(0, 4)).toMatchObject([
      { id: "session-1", type: "session", version: 3 },
      { id: "opaque-1", payload: { keep: "exact" }, type: "plugin_state" },
      { message: { content: [{ type: "text", text: "legacy string" }] } },
      { firstKeptEntryId: message.id, parentId: message.id },
    ]);
    expect(events[0]).not.toHaveProperty("sessionId");
    expect(events[1]).toEqual({
      id: "opaque-1",
      payload: { keep: "exact" },
      type: "plugin_state",
    });
    const manager = SessionManager.open(sessionScope(store), store.tempDir);
    expect(
      manager.appendMessage({
        content: "post-import message",
        role: "user",
        timestamp: Date.now(),
      }),
    ).toEqual(expect.any(String));
    closeDatabases();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const migrated = new sqlite.DatabaseSync(
      resolveOpenClawAgentSqlitePath({ agentId: "main", env: store.env }),
      { readOnly: true },
    );
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        migrated
          .prepare(
            "SELECT session_id, length(generation) AS generation_length FROM transcript_rewrite_watermarks",
          )
          .all(),
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

  it("imports July-2026 session fields and preserves the transcript mutation watermark", async () => {
    const store = createLegacyStore({
      entryOverrides: {
        channel: "telegram",
        groupChannel: "July group",
        lastChannel: "telegram",
        lastTo: "123",
        provider: "stale-provider",
        lastProvider: "stale-last-provider",
        room: "stale-room",
      },
      transcriptLines: [
        '{"type":"session","version":3,"id":"session-1","timestamp":"2026-07-01T23:00:00.000Z","cwd":"/fixture"}',
        '{"type":"message","id":"july-message","parentId":null,"message":{"role":"user","content":"July history"}}',
      ],
    });
    const transcriptMtimeMs = 1_700_000_000_000;
    const transcriptMtime = new Date(transcriptMtimeMs);
    fs.utimesSync(store.transcriptPath, transcriptMtime, transcriptMtime);

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(readTranscriptStatsSync(sessionScope(store)).lastMutationAtMs).toBe(transcriptMtimeMs);
    expect(readEntry(sessionScope(store))?.entry).toMatchObject({
      groupChannel: "July group",
      delivery: { kind: "external", context: { channel: "telegram", to: "123" } },
    });
    expect(readEvents(sessionScope(store))[1]).toMatchObject({
      id: "july-message",
      message: { content: "July history" },
    });
  });

  it("preserves a same-generation canonical harness owner during legacy import", async () => {
    const store = createLegacyStore({
      entryOverrides: { lifecycleRevision: "rev-1" },
    });
    await upsertEntry(sessionScope(store), {
      agentHarnessId: "codex",
      lifecycleRevision: "rev-1",
      sessionId: "session-1",
      updatedAt: 3000,
    });
    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(readEntry(sessionScope(store))?.entry).toMatchObject({
      agentHarnessId: "codex",
      lifecycleRevision: "rev-1",
      sessionId: "session-1",
    });
  });

  it("preserves required creation provenance when importing an older legacy row", async () => {
    const store = createLegacyStore({
      entryOverrides: {
        createdActor: { id: "profile-legacy", type: "human" },
        createdAt: 1000,
        createdVia: "channel",
      },
    });
    const authoritativeStamp = {
      createdActor: { id: "profile-protected", type: "human", source: "profile" },
      createdAt: 1500,
      createdVia: "operator",
      sandbox: "required",
    } as const;
    const scope = sessionScope(store);
    await upsertEntry(scope, {
      ...authoritativeStamp,
      sessionId: "session-1",
      updatedAt: 3000,
    });
    const report = await importLegacyStore(store);
    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(readEntry(scope)?.entry).toMatchObject({
      ...authoritativeStamp,
      sessionId: "session-1",
    });
  });

  it("archives legacy stores with valid sessions and invalid cron stubs without failing", async () => {
    const store = createLegacyStore();
    const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const cronStubKey = "agent:main:cron:legacy-stub";
    legacyStore[cronStubKey] = { updatedAt: 1500 };
    writePrivateFile(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`);

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
    const archivedStorePath = expectDefined(
      report.targets[0]?.archivedLegacyStoreFiles?.[0],
      "archived legacy store path",
    );
    expectMissing(store.storePath);
    expect(fs.existsSync(archivedStorePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(archivedStorePath, "utf-8"))).toMatchObject({
      [cronStubKey]: { updatedAt: 1500 },
    });

    const manifest = readManifest(report.migrationRun?.manifestPath);
    expect(manifest.failedAt).toBeUndefined();
    expect(manifest.failureReports).toBeUndefined();
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
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
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
});
