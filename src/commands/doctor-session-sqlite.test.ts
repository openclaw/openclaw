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
import { createTranscriptEventReader } from "./doctor-session-sqlite-readers.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it("imports every legacy Codex assistant message, not only the last one", async () => {
    const codexReply = (id: string, parentId: string, content: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        message: { role: "assistant", provider: "codex", api: "openai-chatgpt-responses", content },
      });
    const userMessage = (id: string, parentId: string | null, content: string) =>
      JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } });
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        userMessage("user-1", null, "hi"),
        codexReply("reply-1", "user-1", "a"),
        userMessage("user-2", "reply-1", "b"),
        codexReply("reply-2", "user-2", "c"),
        userMessage("user-3", "reply-2", "d"),
      ],
    });

    const imported = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(imported.targets[0]?.issues).toEqual([]);
    expect(imported.totals).toMatchObject({ importedTranscriptEvents: 6 });
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        storePath: store.storePath,
        sessionId: "session-1",
      }),
    ).toEqual(
      ["session-1", "user-1", "reply-1", "user-2", "reply-2", "user-3"].map((id) =>
        expect.objectContaining({ id }),
      ),
    );
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
    const imported = loadExactSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    });
    // The SQLite runtime does no read repair, so import must store canonical shapes.
    expect(typeof sessionDeliveryRoute(imported?.entry)).not.toBe("string");
    const events = loadTranscriptEventsSync({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    });
    const message = events.find((event) => (event as { type?: string }).type === "message") as {
      id?: string;
      message?: { content?: unknown };
    };
    const compaction = events.find(
      (event) => (event as { type?: string }).type === "compaction",
    ) as { firstKeptEntryId?: string; parentId?: string };
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
    expect(message?.message?.content).toEqual([{ type: "text", text: "legacy string" }]);
    expect(compaction).toMatchObject({
      firstKeptEntryId: message.id,
      parentId: message.id,
    });
    const manager = SessionManager.open(
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      store.tempDir,
    );
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

  it("aborts import when the legacy transcript changes between passes", () => {
    const store = createLegacyStore();
    const realStatSync = fs.statSync.bind(fs);
    let fingerprintReads = 0;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((candidate, options) => {
      const stat = realStatSync(candidate, options as never);
      if (
        path.resolve(String(candidate)) === path.resolve(store.transcriptPath) &&
        (options as { bigint?: boolean } | undefined)?.bigint === true
      ) {
        fingerprintReads += 1;
        if (fingerprintReads === 2) {
          fs.appendFileSync(store.transcriptPath, '{"type":"custom","customType":"late"}\n');
        }
      }
      return stat;
    }) as typeof fs.statSync);

    try {
      const events: unknown[] = [];
      expect(() =>
        createTranscriptEventReader(
          store.transcriptPath,
          "session-1",
        )((event) => {
          events.push(event);
        }),
      ).toThrow(/stop active session writers and rerun `openclaw doctor --fix`/);
      expect(events).toEqual([]);
    } finally {
      statSpy.mockRestore();
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
    expect(
      readTranscriptStatsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }).lastMutationAtMs,
    ).toBe(transcriptMtimeMs);
  });

  it("preserves a same-generation canonical harness owner during legacy import", async () => {
    const store = createLegacyStore({
      entryOverrides: { lifecycleRevision: "rev-1" },
    });
    await upsertSessionEntryCore(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      {
        agentHarnessId: "codex",
        lifecycleRevision: "rev-1",
        sessionId: "session-1",
        updatedAt: 3000,
      },
    );
    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).toMatchObject({
      agentHarnessId: "codex",
      lifecycleRevision: "rev-1",
      sessionId: "session-1",
    });
  });

  it.each([true, false])(
    "preserves required=%s creation provenance when importing an older legacy row",
    async (required) => {
      const legacyStamp = {
        createdActor: { id: "profile-legacy", type: "human" as const },
        createdAt: 1000,
        createdVia: "channel" as const,
      };
      const authoritativeStamp = {
        createdActor: {
          id: "profile-protected",
          type: "human" as const,
          source: "profile" as const,
        },
        createdAt: 1500,
        createdVia: "operator" as const,
        ...(required ? { sandbox: "required" as const } : {}),
      };
      const store = createLegacyStore({ entryOverrides: legacyStamp });
      const scope = {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      };
      await upsertSessionEntryCore(scope, {
        ...authoritativeStamp,
        sessionId: "session-1",
        updatedAt: 3000,
      });

      const report = await importLegacyStore(store);

      expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
      const imported = loadExactSessionEntry(scope)?.entry;
      expect(imported).toMatchObject({
        ...(required
          ? authoritativeStamp
          : {
              ...legacyStamp,
              createdActor: { ...legacyStamp.createdActor, source: "channel" },
            }),
        sessionId: "session-1",
      });
      if (!required) {
        expect(imported).not.toHaveProperty("sandbox");
      }
    },
  );

  it("imports and validates legacy sessions idempotently", async () => {
    const store = createLegacyStore();

    const firstImport = await importLegacyStore(store);
    const secondImport = await importLegacyStore(store);
    const validation = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });
    const inspect = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(firstImport.totals).toMatchObject({
      archivedLegacyStoreFiles: 1,
      archivedTranscriptFiles: 2,
      archivedUnreferencedJsonlFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
      unreferencedJsonlFiles: 0,
    });
    expect(secondImport.totals).toMatchObject({
      archivedLegacyStoreFiles: 0,
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      sqliteEntries: 0,
      unreferencedJsonlFiles: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(validation.totals).toMatchObject({
      issues: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(fs.existsSync(store.trajectoryPath)).toBe(false);
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(false);
    expect(firstImport.targets[0]?.archivedTranscriptFiles).toHaveLength(2);
    for (const archivedTranscriptPath of firstImport.targets[0]?.archivedTranscriptFiles ?? []) {
      expect(archivedTranscriptPath).toBeTruthy();
      expect(archivedTranscriptPath).not.toContain(`${path.sep}sessions${path.sep}`);
      expect(fs.existsSync(archivedTranscriptPath)).toBe(true);
    }
    expect(firstImport.targets[0]?.archivedUnreferencedJsonlFiles).toHaveLength(1);
    const archivedUnreferencedPath = expectDefined(
      firstImport.targets[0]?.archivedUnreferencedJsonlFiles[0],
      "firstImport.targets[0]?.archivedUnreferencedJsonlFiles[0] test invariant",
    );
    expect(archivedUnreferencedPath).toBeTruthy();
    expect(archivedUnreferencedPath).not.toContain(`${path.sep}sessions${path.sep}`);
    expect(archivedUnreferencedPath).toContain("archive-tier.orphan.jsonl.imported-");
    expect(fs.existsSync(archivedUnreferencedPath)).toBe(true);
    expect(fs.readFileSync(archivedUnreferencedPath, "utf-8")).toBe('{"type":"event"}\n');
    expect(inspect.totals.sqliteEntries).toBe(1);
    expect(inspect.totals.unreferencedJsonlFiles).toBe(0);
    expect(
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).not.toHaveProperty("sessionFile");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
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
    expect(
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).not.toHaveProperty("sessionFile");
  });
});
