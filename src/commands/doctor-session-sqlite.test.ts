import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.sqlite-read.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { sessionDeliveryRoute } from "../utils/delivery-context.read.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
  type TestStore,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

function sessionScope(store: TestStore) {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    storePath: store.storePath,
    env: store.env,
  };
}

describe("runDoctorSessionSqlite", () => {
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
    const imported = loadExactSessionEntry(sessionScope(store));
    // The SQLite runtime does no read repair, so import must store canonical shapes.
    expect(typeof sessionDeliveryRoute(imported?.entry)).not.toBe("string");
    const events = loadTranscriptEventsSync(sessionScope(store));
    const message = events[2];
    assert(
      message !== null &&
        typeof message === "object" &&
        "id" in message &&
        typeof message.id === "string",
    );
    const compaction = events[3];
    expect(events[0]).toMatchObject({
      id: "session-1",
      type: "session",
      version: 3,
    });
    expect(events[0]).not.toHaveProperty("sessionId");
    expect(events[1]).toEqual({
      id: "opaque-1",
      payload: { keep: "exact" },
      type: "plugin_state",
    });
    expect(message).toMatchObject({
      message: { content: [{ type: "text", text: "legacy string" }] },
    });
    expect(compaction).toMatchObject({
      firstKeptEntryId: message.id,
      parentId: message.id,
    });
    const manager = SessionManager.open(sessionScope(store), store.tempDir);
    expect(
      manager.appendMessage({
        content: "post-import message",
        role: "user",
        timestamp: Date.now(),
      }),
    ).toEqual(expect.any(String));
    closeOpenClawAgentDatabasesForTest();
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

  it("preserves the legacy transcript mtime as the SQLite mutation watermark", async () => {
    const store = createLegacyStore();
    const transcriptMtimeMs = 1_700_000_000_000;
    const transcriptMtime = new Date(transcriptMtimeMs);
    fs.utimesSync(store.transcriptPath, transcriptMtime, transcriptMtime);

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(readTranscriptStatsSync(sessionScope(store)).lastMutationAtMs).toBe(transcriptMtimeMs);
  });

  it("preserves a same-generation canonical harness owner during legacy import", async () => {
    const store = createLegacyStore({
      entryOverrides: { lifecycleRevision: "rev-1" },
    });
    await upsertSessionEntryCore(sessionScope(store), {
      agentHarnessId: "codex",
      lifecycleRevision: "rev-1",
      sessionId: "session-1",
      updatedAt: 3000,
    });
    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(loadExactSessionEntry(sessionScope(store))?.entry).toMatchObject({
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
    await upsertSessionEntryCore(scope, {
      ...authoritativeStamp,
      sessionId: "session-1",
      updatedAt: 3000,
    });
    const report = await importLegacyStore(store);
    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
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
    fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, { mode: 0o600 });

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
    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.existsSync(archivedStorePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(archivedStorePath, "utf-8"))).toMatchObject({
      [cronStubKey]: { updatedAt: 1500 },
    });

    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
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
    closeOpenClawAgentDatabasesForTest();
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
    fs.writeFileSync(
      store.storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            channel: "cli",
            chatType: "direct",
            sessionFile: `sqlite:main:session-1:${store.storePath}`,
            sessionId: "session-1",
            sessionStartedAt: 1000,
            updatedAt: 2000,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const report = await importLegacyStore(store);
    const validation = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

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
    expect(loadExactSessionEntry(sessionScope(store))?.entry).not.toHaveProperty("sessionFile");
  });
});
