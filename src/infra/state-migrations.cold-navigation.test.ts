import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import * as navigation from "../config/sessions/session-cold-storage-navigation.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentSchema } from "../state/openclaw-agent-db-schema.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { seedAgentV38Schema } from "../state/schema-migration.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import { migrateSessionColdNavigation } from "./state-migrations.cold-navigation.js";
import { mediaRowsNeedMigration } from "./state-migrations.media-persistence-database.js";
import { MASKED_TRANSCRIPT_PROVIDER } from "./state-migrations.transcript-directives-transform.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";
import { resolveZstdCodec } from "./zstd-codec.js";

function seedArchive(database: DatabaseSync, sessionId: string, withoutIndex = false) {
  const event = JSON.stringify({
    type: "message",
    id: "message",
    parentId: null,
    message: {
      role: "assistant",
      provider: MASKED_TRANSCRIPT_PROVIDER,
      content: [
        { type: "text", text: "[[reply_to_current]] synthetic retained payload".repeat(256) },
      ],
    },
  });
  const records = [
    { kind: "header", version: 1, sessionId, generation: "retained" },
    { kind: "event", row: { seq: 0, event_json: event, created_at: 7 } },
    {
      kind: "identity",
      row: {
        event_id: "message",
        seq: 0,
        event_type: "message",
        parent_id: null,
        message_idempotency_key: "persisted-fact",
        created_at: 8,
      },
    },
    {
      kind: "active",
      row: { active_position: 0, event_seq: 0, message_position: 0, context_eligible: 1 },
    },
    {
      kind: "index",
      row: {
        indexed_seq: 0,
        leaf_event_id: "message",
        needs_rebuild: 0,
        active_event_count: 1,
        active_message_count: 1,
        updated_at: 9,
      },
    },
  ];
  const bytes = zstdCompressSync(
    Buffer.from(
      records
        .filter((record) => !withoutIndex || (record.kind !== "index" && record.kind !== "active"))
        .map((record) => JSON.stringify(record))
        .join("\n"),
    ),
  );
  database
    .prepare(`INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
    VALUES (?, 'agent:main:retained', 1, 1)`)
    .run(sessionId);
  database
    .prepare(`INSERT INTO session_transcript_cold_archives
    (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
     archive_bytes, last_seq, archived_at, storage, archive_blob)
    VALUES (?, 'retained', ?, ?, 1, ?, ?, 0, 1, 'sqlite', ?)`)
    .run(
      sessionId,
      `${sessionId}.zst`,
      createHash("sha256").update(bytes).digest("hex"),
      Buffer.byteLength(event),
      bytes.length,
      bytes,
    );
  return event;
}

it("stops between complete archives after ten minutes and resumes the pending archives", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    openOpenClawStateDatabase({ env: state.env });
    const pathname = path.join(state.agentDir(), "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    {
      using database = new DatabaseSync(pathname);
      seedAgentV38Schema(database);
      database.exec(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:retained', 'archive-a', '{"sessionId":"archive-a","updatedAt":1}', 1);`);
      for (const id of ["archive-a", "archive-b", "archive-c"]) {
        seedArchive(database, id);
      }
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
        ensureOpenClawAgentSchema(database, "main", pathname);
      });
    }
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const backfill = navigation.backfillSessionColdNavigationInTransaction;
    const observed = vi
      .spyOn(navigation, "backfillSessionColdNavigationInTransaction")
      .mockImplementation((database, archive) => {
        backfill(database, archive);
        elapsed += 300_001;
      });
    try {
      const result = await migrateSessionColdNavigation({ env: state.env });
      expect(result.warningDisposition).toBe("recoverable");
      expect(result.warnings).toContainEqual(
        expect.stringContaining("migrated 2, pending 1; resumes on the next doctor run"),
      );
      using database = new DatabaseSync(pathname, { readOnly: true });
      for (const table of [
        "transcript_events",
        "transcript_event_identities",
        "session_transcript_active_events",
        "session_transcript_index_state",
      ]) {
        expect(
          database.prepare(`SELECT session_id FROM ${table} ORDER BY session_id`).all(),
        ).toEqual([{ session_id: "archive-a" }, { session_id: "archive-b" }]);
      }
    } finally {
      observed.mockRestore();
      clock.mockRestore();
    }
    const resumed = await migrateSessionColdNavigation({ env: state.env });
    expect(resumed.warnings).toEqual([]);
    expect(resumed.changes).toContainEqual(
      expect.stringContaining("Retained navigation for 1 cold transcript(s)"),
    );
    using database = new DatabaseSync(pathname, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM transcript_events").get()).toEqual({
      count: 3,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

it("resumes a backed-up pre-change archive migration after interruption without restoring payloads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    openOpenClawStateDatabase({ env: state.env });
    const pathname = path.join(state.agentDir(), "openclaw-agent.sqlite");
    let archivedEvent: string;
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    {
      using database = new DatabaseSync(pathname);
      seedAgentV38Schema(database);
      database.exec(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:retained', 'hot', '{"sessionId":"hot","updatedAt":1}', 1);
        INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
        VALUES ('hot', 'agent:main:retained', 1, 1);`);
      seedArchive(database, "archive-a");
      archivedEvent = seedArchive(database, "archive-b", true);
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
        ensureOpenClawAgentSchema(database, "main", pathname);
      });
    }
    const inspect = () => {
      using database = new DatabaseSync(pathname, { readOnly: true });
      return {
        archives: database
          .prepare("SELECT * FROM session_transcript_cold_archives ORDER BY session_id")
          .all(),
        events: database
          .prepare(
            "SELECT session_id, seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events ORDER BY session_id",
          )
          .all(),
        identities: database
          .prepare("SELECT * FROM transcript_event_identities ORDER BY session_id")
          .all(),
        active: database
          .prepare("SELECT * FROM session_transcript_active_events ORDER BY session_id")
          .all(),
        index: database
          .prepare("SELECT * FROM session_transcript_index_state ORDER BY session_id")
          .all(),
        foreignKeys: database.prepare("PRAGMA foreign_key_check").all(),
      };
    };
    const before = inspect();
    const controller = new AbortController();
    const interruption = new Error("synthetic Doctor interruption");
    const backfill = navigation.backfillSessionColdNavigationInTransaction;
    const compress = vi.spyOn(resolveZstdCodec(), "compress");
    const observed = vi
      .spyOn(navigation, "backfillSessionColdNavigationInTransaction")
      .mockImplementation((database, archive) => {
        if (archive.session_id === "archive-b") {
          controller.abort(interruption);
          throw interruption;
        }
        backfill(database, archive);
      });
    try {
      await expect(
        withSqliteReadOnlyWorkerScope(() => migrateSessionColdNavigation({ env: state.env }), {
          signal: controller.signal,
          deadlineOwnedByCaller: true,
        }),
      ).rejects.toBe(interruption);
      expect(compress).not.toHaveBeenCalled();
    } finally {
      observed.mockRestore();
      compress.mockRestore();
    }
    const interrupted = inspect();
    expect(interrupted.events.map((event) => event.session_id)).toEqual(["archive-a"]);
    expect(interrupted.archives).toEqual(before.archives);
    const result = await migrateSessionColdNavigation({ env: state.env });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContainEqual(
      expect.stringContaining("Retained navigation for 1 cold transcript(s)"),
    );
    const after = inspect();
    expect(after.archives).toEqual(before.archives);
    expect(after.events).toHaveLength(2);
    expect(
      after.events.every(
        (event) =>
          event.event_json === null &&
          event.event_zstd === null &&
          Number(event.event_utf8_bytes) > 0,
      ),
    ).toBe(true);
    expect(after.identities.map((identity) => identity.message_idempotency_key)).toEqual([
      "persisted-fact",
      "persisted-fact",
    ]);
    expect(after.active).toHaveLength(2);
    expect(after.index).toHaveLength(2);
    expect(after.index.every((index) => index.needs_rebuild === 0)).toBe(true);
    expect(after.foreignKeys).toEqual([]);
    expect(await migrateSessionColdNavigation({ env: state.env })).toEqual({
      changes: [],
      warnings: [],
    });
    const backups = fs
      .readdirSync(path.dirname(pathname))
      .filter((name) => name.startsWith("openclaw-cold-navigation-recovery-"));
    expect(backups).toHaveLength(2);
    // Both compact navigation and exceptional inline rows retain archive ownership.
    {
      using database = new DatabaseSync(pathname);
      database
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = 'archive-b'")
        .run(archivedEvent);
      expect(mediaRowsNeedMigration(database, pathname)).toBe(false);
    }
    const retained = inspect();
    expect(await migrateHistoricalTranscriptDirectives({ env: state.env })).toEqual({
      changes: [],
      warnings: [],
    });
    expect(inspect()).toEqual(retained);
  });
});
