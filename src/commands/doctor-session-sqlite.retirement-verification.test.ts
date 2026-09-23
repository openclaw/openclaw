import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  readSessionTranscriptHistoryEventCount,
  readSessionTranscriptHistoryEventPage,
} from "../config/sessions/session-accessor.sqlite-history-events.js";
import {
  readSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventById,
} from "../config/sessions/session-accessor.sqlite-history.test-support.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import * as sqliteReaders from "../infra/session-sqlite-migration-readers.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
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
  it.each([
    { name: "invalid message", rows: [{ type: "message", id: "bad", message: {} }] },
    { name: "unknown event", rows: [{ type: "future_event", id: "unknown", payload: "unique" }] },
    {
      name: "duplicate divergent ID",
      rows: [
        {
          type: "message",
          id: "duplicate",
          parentId: null,
          message: { role: "user", content: "first" },
        },
        {
          type: "message",
          id: "duplicate",
          parentId: null,
          message: { role: "user", content: "unique second" },
        },
      ],
    },
    {
      name: "missing ancestor",
      rows: [
        {
          type: "message",
          id: "child",
          parentId: "missing",
          message: { role: "user", content: "history" },
        },
      ],
    },
  ])("protects $name and its recovery index", async ({ rows, name }) => {
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        ...rows.map((row) => JSON.stringify(row)),
      ],
    });
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await importLegacyStore(store);
    const move = readMigrationManifest(
      imported.migrationRun?.manifestPath,
    ).targets[0]!.completedMoves.find((item) => item.kind === "transcript");
    if (name === "duplicate divergent ID") {
      expect(move).toBeUndefined();
      expect(imported.targets[0]?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "sqlite_transcript_count_mismatch" }),
        ]),
      );
    } else {
      expect(move).toBeDefined();
    }
    closeOpenClawAgentDatabasesForTest();
    const result = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(result.totals.removedFiles).toBe(0);
    if (move) {
      expect(result.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
        "protected",
      );
    }
    expect(fs.readFileSync(move?.archivePath ?? store.transcriptPath)).toEqual(original);
  });

  it("archives identical indexed and leaf replays after normalized history verification", async () => {
    const repeatedMessage = {
      type: "message",
      id: "reply",
      parentId: "root",
      message: { role: "assistant", content: "same replay" },
    };
    const repeatedLeaf = {
      type: "leaf",
      id: "selection",
      parentId: "reply",
      targetId: "reply",
    };
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        JSON.stringify({
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        }),
        JSON.stringify(repeatedMessage),
        JSON.stringify(repeatedMessage),
        JSON.stringify(repeatedLeaf),
        JSON.stringify(repeatedLeaf),
      ],
    });

    const imported = await importLegacyStore(store);

    expect(imported.targets[0]?.issues).toEqual([]);
    const move = readMigrationManifest(
      imported.migrationRun?.manifestPath,
    ).targets[0]!.completedMoves.find((item) => item.kind === "transcript");
    expect(move).toBeDefined();
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        env: store.env,
        sessionId: "session-1",
      }).map((event) => (event as { id?: string }).id),
    ).toEqual(["session-1", "root", "reply", "selection"]);

    const scope = { agentId: "main", env: store.env, sessionId: "session-1" };
    const history = readSessionTranscriptHistoryEvents(scope);
    expect(history.map((row) => (row.event as { id?: string }).id)).toEqual(["root", "reply"]);
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(2);
    expect(
      readSessionTranscriptHistoryEventPage(scope, { maxMessages: 1, offset: 0 }),
    ).toMatchObject({
      activeLeafEntryId: "reply",
      totalMessages: 2,
      events: [expect.objectContaining({ event: expect.objectContaining({ id: "reply" }) })],
    });
    expect(readSessionTranscriptHistoryEventById(scope, "reply")).toMatchObject({
      event: expect.objectContaining({ id: "reply" }),
    });
  });

  it("retains complete recovery when durable transcript verification is short", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        JSON.stringify({
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        }),
      ],
    });
    const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
    const spy = vi
      .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
      .mockImplementation((target) => {
        const result = snapshot(target);
        if (!result.ok) {
          return result;
        }
        const counts = new Map(result.snapshot.transcriptEventCountsBySessionId);
        counts.set("session-1", 1);
        return {
          ok: true,
          snapshot: { ...result.snapshot, transcriptEventCountsBySessionId: counts },
        };
      });
    let imported;
    try {
      imported = await importLegacyStore(store);
    } finally {
      spy.mockRestore();
    }

    expect(imported.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "sqlite_transcript_count_mismatch" }),
      ]),
    );
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(
      readMigrationManifest(imported.migrationRun?.manifestPath).targets[0]?.completedMoves.some(
        (item) => item.kind === "transcript",
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "identical",
      repeated: { role: "assistant", content: "same replay" },
      archived: true,
    },
    {
      name: "divergent",
      repeated: { role: "assistant", content: "different replay" },
      archived: false,
    },
  ])(
    "handles a $name replay against an existing destination and retry",
    async ({ repeated, archived }) => {
      const first = {
        type: "message",
        id: "reply",
        parentId: "root",
        message: { role: "assistant", content: "same replay" },
      };
      const sourceEvents = [
        { type: "session", id: "session-1", version: 3 },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        },
        first,
        { ...first, message: repeated },
      ];
      const store = createLegacyStore({
        transcriptLines: sourceEvents.map((event) => JSON.stringify(event)),
      });
      await importSqliteSessionRows({
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
        entry: { sessionId: "session-1", updatedAt: 1000 },
        readTranscriptEvents: (append) => sourceEvents.slice(0, 3).forEach(append),
      });

      const run = () => importLegacyStore(store);
      const imported = await run();
      expect(fs.existsSync(store.transcriptPath)).toBe(!archived);
      expect(
        readMigrationManifest(imported.migrationRun?.manifestPath).targets[0]?.completedMoves.some(
          (item) => item.kind === "transcript",
        ),
      ).toBe(archived);
      expect(
        imported.targets[0]?.issues.some(
          (issue) => issue.code === "sqlite_transcript_count_mismatch",
        ),
      ).toBe(!archived);
      expect(
        loadTranscriptEventsSync({
          agentId: "main",
          env: store.env,
          sessionId: "session-1",
        }).map((event) => (event as { id?: string }).id),
      ).toEqual(["session-1", "root", "reply"]);

      if (!archived) {
        const retried = await run();
        expect(
          retried.targets[0]?.issues.some(
            (issue) => issue.code === "sqlite_transcript_count_mismatch",
          ),
        ).toBe(true);
        expect(fs.existsSync(store.transcriptPath)).toBe(true);
      }
    },
  );

  it("retires verified exact originals while preserving current SQLite and unknown archives", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        JSON.stringify({
          type: "message",
          id: "original-only",
          parentId: null,
          message: {
            role: "user",
            content:
              "hello\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nretired context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "message",
          id: "reply-1",
          parentId: "user-1",
          message: { role: "assistant", provider: "openai-codex", content: "hello back" },
        }),
      ],
    });
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await importLegacyStore(store);
    expect(imported.targets[0]?.issues).toEqual([]);
    const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
    const originalMove = manifest.targets[0]!.completedMoves.find(
      (move) => move.kind === "transcript",
    )!;
    expect(fs.readFileSync(originalMove.archivePath)).toEqual(original);
    expect(originalMove.artifact?.classification).toBe("repair-original");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        storePath: store.storePath,
        sessionId: "session-1",
      }),
    ).toEqual(["session-1", "user-1", "reply-1"].map((id) => expect.objectContaining({ id })));
    const manager = SessionManager.open(
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      store.tempDir,
    );
    manager.appendMessage({
      role: "user",
      content: "history written after the upgrade",
      timestamp: Date.now(),
    });
    closeOpenClawAgentDatabasesForTest();
    const sqlitePath = imported.targets[0]!.sqlitePath;
    const databaseBefore = fs.readFileSync(sqlitePath);
    expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(false);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    expect(preview.artifacts.find((item) => item.path === originalMove.archivePath)?.outcome).toBe(
      "candidate",
    );
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview,
      readConfig: async () => ({}),
      confirm: async () => {
        // The actual read-only owner inspection creates these sidecars before confirmation.
        expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(true);
        expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(true);
        return true;
      },
    });
    expect(cleanup.status).toBe("complete");
    expect(cleanup.totals.removedFiles).toBe(2);
    expect(cleanup.totals.removedBytes).toBeGreaterThan(original.length);
    expect(fs.existsSync(originalMove.archivePath)).toBe(false);
    expect(fs.readFileSync(sqlitePath)).toEqual(databaseBefore);
    expect(cleanup.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(2);
    const retry = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(retry.totals.removedBytes).toBe(0);
    const restored = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });
    expect(
      restored.targets[0]?.restore?.conflicts.some((item) =>
        item.reason.includes("intentionally disposed"),
      ),
    ).toBe(true);
  });
});
