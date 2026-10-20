import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { prepareTrajectoryPayload } from "../trajectory/runtime-payload.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { encodeArchiveContent } from "./state-migrations.transcript-directives-archives.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";
import {
  type FixtureEvent,
  insertSession,
  messageEvent,
  readEventJson,
  readGeneration,
  readMigrationCursor,
} from "./state-migrations.transcript-directives.test-support.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("historical transcript masked provider repair", () => {
  const MASKED = '"provider":"***"';

  function maskedAssistant(id: string, model: string, timestamp: number): FixtureEvent {
    const event = messageEvent({
      content: [{ type: "text", text: `Answer ${id}` }],
      id,
      role: "assistant",
      timestamp,
    });
    Object.assign(event.message as Record<string, unknown>, { model, provider: "***" });
    return event;
  }

  function insertTrajectory(
    database: import("node:sqlite").DatabaseSync,
    sessionId: string,
    facts: Array<{ modelId: string; provider: string }>,
    mixedStorage = false,
  ): void {
    const insert = database.prepare(
      `INSERT INTO trajectory_runtime_events(
         session_id,seq,run_id,event_json,created_at,event_payload,event_codec,event_utf8_bytes
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (const [seq, fact] of facts.entries()) {
      const eventJson = JSON.stringify({
        type: "model.completed",
        sessionId,
        ...fact,
        ...(mixedStorage
          ? {
              data: {
                messagesSnapshot: [{ role: "user", content: "retained payload ".repeat(256) }],
              },
            }
          : {}),
      });
      const payload =
        mixedStorage && seq % 2 === 0
          ? prepareTrajectoryPayload(database, eventJson)
          : {
              event_json: eventJson,
              event_payload: null,
              event_codec: null,
              event_utf8_bytes: null,
            };
      if (mixedStorage && seq % 2 === 0) {
        expect(payload.event_codec).not.toBeNull();
      }
      insert.run(
        sessionId,
        seq,
        "run",
        payload.event_json,
        seq,
        payload.event_payload,
        payload.event_codec,
        payload.event_utf8_bytes,
      );
    }
  }

  function compressTranscriptRows(database: import("node:sqlite").DatabaseSync): void {
    const update = database.prepare(
      "UPDATE transcript_events SET event_json = NULL, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = ?",
    );
    for (const row of database
      .prepare("SELECT session_id, seq, event_json FROM transcript_events")
      .all() as Array<{ event_json: string; seq: number; session_id: string }>) {
      const payload = prepareTranscriptPayload(database, row.event_json);
      expect(payload.event_zstd).not.toBeNull();
      update.run(
        payload.event_zstd,
        payload.event_utf8_bytes,
        payload.navigation_json,
        row.session_id,
        row.seq,
      );
    }
  }

  function writeCursor(database: import("node:sqlite").DatabaseSync, cursor: unknown): void {
    database
      .prepare(
        `INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run("historical-transcript-directives-v1", "agent", 1, "main", JSON.stringify(cursor), 1, 1);
  }

  it.each(["identity", "zstd"])(
    "restores %s masked providers from recorded session facts and leaves ambiguity masked",
    async (storage) => {
      const stateDir = makeTempDir(tempDirs, "transcript-masked-provider-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const opened = openOpenClawAgentDatabase({ agentId: "main", env });
      const databasePath = opened.path;
      const database = requireNativeSqliteDatabase(opened.db);
      const copilot = maskedAssistant("copilot", "claude-opus-5.5", 1);
      const user = messageEvent({ content: "next", id: "user", role: "user", timestamp: 2 });
      const openai = maskedAssistant("openai", "gpt-6.1-sol", 3);
      // A masked-looking value outside message.provider is not a candidate.
      const toolCall = messageEvent({
        content: [{ type: "toolCall", id: "call", name: "probe", arguments: { provider: "***" } }],
        id: "tool-call",
        role: "assistant",
        timestamp: 4,
      });
      const ambiguous = maskedAssistant("ambiguous", "claude-opus-5.5", 5);
      const unrecorded = maskedAssistant("unrecorded", "claude-opus-5.5", 6);
      if (storage === "zstd") {
        for (const event of [copilot, user, openai, toolCall, ambiguous, unrecorded]) {
          event.fixturePadding = "compression fixture ".repeat(256);
        }
      }
      insertSession(database, {
        events: [copilot, user, openai, toolCall],
        generation: "multi-before",
        sessionId: "multi-session",
      });
      insertSession(database, {
        events: [ambiguous],
        generation: "ambiguous-before",
        sessionId: "ambiguous-session",
      });
      insertSession(database, {
        events: [unrecorded],
        generation: "unrecorded-before",
        sessionId: "unrecorded-session",
      });
      insertSession(database, {
        events: [],
        generation: "archived-before",
        sessionId: "archived-session",
      });
      if (storage === "zstd") {
        compressTranscriptRows(database);
      }
      insertTrajectory(
        database,
        "multi-session",
        [
          { modelId: "claude-opus-5.5", provider: "github-copilot" },
          { modelId: "claude-opus-5.5", provider: "github-copilot" },
          { modelId: "gpt-6.1-sol", provider: "openai" },
          { modelId: "gpt-6.1-sol", provider: "***" },
        ],
        storage === "zstd",
      );
      insertTrajectory(
        database,
        "ambiguous-session",
        [
          { modelId: "claude-opus-5.5", provider: "github-copilot" },
          { modelId: "claude-opus-5.5", provider: "openrouter" },
        ],
        storage === "zstd",
      );
      insertTrajectory(
        database,
        "archived-session",
        [{ modelId: "claude-opus-5.5", provider: "github-copilot" }],
        storage === "zstd",
      );

      const archived = maskedAssistant("archived", "claude-opus-5.5", 7);
      const archivedUser = messageEvent({
        content: "hi",
        id: "a-user",
        role: "user",
        timestamp: 8,
      });
      const archiveContent = `${JSON.stringify(archived)}\n${JSON.stringify(archivedUser)}\n`;
      const archiveEncoding = storage === "zstd" ? "zstd" : "identity";
      const archiveBytes = encodeArchiveContent(archiveContent, archiveEncoding, "fixture");
      const archiveName = `archived-session.jsonl.deleted.2026-01-01T00-00-00.000Z.archive-gen${archiveEncoding === "zstd" ? SESSION_ARCHIVE_ZSTD_SUFFIX : ""}`;
      opened.db
        .prepare(
          `INSERT INTO session_transcript_archives(
          session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "archived-session",
          "archive-gen",
          "agent:main:archived-session",
          "deleted",
          archiveEncoding,
          archiveBytes,
          createHash("sha256").update(archiveBytes).digest("hex"),
          archiveName,
          7,
          8,
        );
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
        agentId: "main",
        path: databasePath,
      });
      fs.mkdirSync(archiveDirectory, { recursive: true });
      const archivePath = path.join(archiveDirectory, archiveName);
      fs.writeFileSync(archivePath, archiveBytes);
      closeOpenClawAgentDatabasesForTest();

      const result = await migrateHistoricalTranscriptDirectives({ env });

      expect(result.changes).toEqual([
        `Restored masked provider on 3 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
        `Repaired historical transcripts in ${databasePath}: 1 active session(s), 1 archived transcript(s).`,
      ]);
      expect(result.warnings).toEqual([
        `Left 2 historical transcript row(s) with masked provider "***" in ${databasePath}: no single provider was recorded for their session and model.`,
      ]);
      expect(result.warningDisposition).toBe("recoverable");
      // Only the provider value changes; every other byte of the event is preserved.
      expect(readEventJson(databasePath, "multi-session", 0)).toBe(
        JSON.stringify(copilot).replace(MASKED, '"provider":"github-copilot"'),
      );
      expect(readEventJson(databasePath, "multi-session", 1)).toBe(JSON.stringify(user));
      expect(readEventJson(databasePath, "multi-session", 2)).toBe(
        JSON.stringify(openai).replace(MASKED, '"provider":"openai"'),
      );
      expect(readEventJson(databasePath, "multi-session", 3)).toBe(JSON.stringify(toolCall));
      expect(readEventJson(databasePath, "ambiguous-session", 0)).toBe(JSON.stringify(ambiguous));
      expect(readEventJson(databasePath, "unrecorded-session", 0)).toBe(JSON.stringify(unrecorded));
      expect(readGeneration(databasePath, "multi-session")).not.toBe("multi-before");
      expect(readGeneration(databasePath, "ambiguous-session")).toBe("ambiguous-before");
      const restoredArchive = `${JSON.stringify(archived).replace(MASKED, '"provider":"github-copilot"')}\n${JSON.stringify(archivedUser)}\n`;
      expect(readSessionArchiveContentSync(archivePath)).toBe(restoredArchive);
      expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
      const migrated = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        // Provider restores record their rows instead of a full database backup.
        expect(
          JSON.parse(
            (
              migrated
                .prepare("SELECT app_version FROM schema_meta WHERE meta_key = ?")
                .get("historical-transcript-masked-provider-restored-v1") as { app_version: string }
            ).app_version,
          ),
        ).toEqual({
          archiveLines: ["archived-session:archive-gen:1"],
          transcriptRows: { "multi-session": [0, 2] },
        });
        // The session index holds no provider, so it stays current without a rebuild.
        expect(
          migrated
            .prepare(
              "SELECT needs_rebuild, indexed_seq FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get("multi-session"),
        ).toEqual({ needs_rebuild: 0, indexed_seq: 3 });
      } finally {
        migrated.close();
      }
      expect(
        fs
          .readdirSync(path.dirname(databasePath))
          .filter((name) => name.startsWith("openclaw-transcript-directives-recovery-")),
      ).toEqual([]);

      const archiveAfterFirstRun = fs.readFileSync(archivePath);
      const generationAfterFirstRun = readGeneration(databasePath, "multi-session");
      await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
        changes: [],
        warnings: [],
      });
      expect(readGeneration(databasePath, "multi-session")).toBe(generationAfterFirstRun);
      expect(fs.readFileSync(archivePath)).toEqual(archiveAfterFirstRun);
    },
  );

  it("reopens a completed version 1 pass once for masked providers only", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-masked-provider-reopen-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    const database = requireNativeSqliteDatabase(opened.db);
    const masked = maskedAssistant("masked", "claude-opus-5.5", 1);
    // Version 1 completion means directives were already handled; this pass must not reparse them.
    const tagged = messageEvent({
      content: [{ type: "text", text: "[[reply_to_current]] kept" }],
      id: "tagged",
      role: "assistant",
      timestamp: 2,
    });
    insertSession(database, { events: [masked, tagged], generation: "g", sessionId: "session" });
    insertTrajectory(database, "session", [
      { modelId: "claude-opus-5.5", provider: "github-copilot" },
    ]);
    writeCursor(database, { phase: "complete" });
    closeOpenClawAgentDatabasesForTest();

    const result = await migrateHistoricalTranscriptDirectives({ env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      `Restored masked provider on 1 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
    );
    expect(readEventJson(databasePath, "session", 0)).toBe(
      JSON.stringify(masked).replace(MASKED, '"provider":"github-copilot"'),
    );
    expect(readEventJson(databasePath, "session", 1)).toBe(JSON.stringify(tagged));
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("backs up and reindexes a session whose rows also need directive normalization", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-masked-provider-directives-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    const database = requireNativeSqliteDatabase(opened.db);
    const masked = maskedAssistant("masked", "claude-opus-5.5", 1);
    const tagged = messageEvent({
      content: [{ type: "text", text: "[[reply_to_current]] Final answer" }],
      id: "tagged",
      role: "assistant",
      timestamp: 2,
    });
    insertSession(database, { events: [masked, tagged], generation: "g", sessionId: "session" });
    insertTrajectory(database, "session", [
      { modelId: "claude-opus-5.5", provider: "github-copilot" },
    ]);
    closeOpenClawAgentDatabasesForTest();

    const result = await migrateHistoricalTranscriptDirectives({ env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringMatching(/^Saved pre-repair SQLite backup: /u),
      `Restored masked provider on 1 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
      `Repaired historical transcripts in ${databasePath}: 1 active session(s), 0 archived transcript(s).`,
    ]);
    expect(readEventJson(databasePath, "session", 0)).toBe(
      JSON.stringify(masked).replace(MASKED, '"provider":"github-copilot"'),
    );
    expect(JSON.parse(readEventJson(databasePath, "session", 1))).toMatchObject({
      message: { content: [{ type: "text", text: "Final answer" }] },
    });
    const migrated = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      // Stripped directive text leaves the search index only through a rebuild.
      expect(
        migrated
          .prepare("SELECT 1 FROM session_transcript_fts WHERE session_transcript_fts MATCH ?")
          .all('"reply_to_current"'),
      ).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("restarts an interrupted version 1 pass from the first session", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-masked-provider-restart-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    const database = requireNativeSqliteDatabase(opened.db);
    const masked = maskedAssistant("masked", "claude-opus-5.5", 1);
    insertSession(database, { events: [masked], generation: "g", sessionId: "a-session" });
    insertTrajectory(database, "a-session", [
      { modelId: "claude-opus-5.5", provider: "github-copilot" },
    ]);
    // Version 1 stopped after this session id; earlier sessions never saw the provider repair.
    writeCursor(database, { phase: "transcripts", sessionId: "z-session" });
    closeOpenClawAgentDatabasesForTest();

    const result = await migrateHistoricalTranscriptDirectives({ env });

    expect(result.warnings).toEqual([]);
    expect(readEventJson(databasePath, "a-session", 0)).toBe(
      JSON.stringify(masked).replace(MASKED, '"provider":"github-copilot"'),
    );
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
  });

  it("leaves masked rows untouched while the agent database writer is active", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-masked-provider-writer-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const database = requireNativeSqliteDatabase(opened.db);
    const masked = maskedAssistant("masked", "claude-opus-5.5", 1);
    insertSession(database, { events: [masked], generation: "g", sessionId: "session" });
    insertTrajectory(database, "session", [
      { modelId: "claude-opus-5.5", provider: "github-copilot" },
    ]);
    writeCursor(database, { phase: "complete" });
    closeOpenClawAgentDatabasesForTest();
    const leaseId = claimOpenClawAgentDatabaseLease({ agentId: "main", path: opened.path, env });

    const result = await migrateHistoricalTranscriptDirectives({ env }).finally(() => {
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("database is still open in another process"),
    ]);
    expect(readEventJson(opened.path, "session", 0)).toBe(JSON.stringify(masked));
    expect(readMigrationCursor(opened.path)).toEqual({ phase: "complete" });
  });
});
