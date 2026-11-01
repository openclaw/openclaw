import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-maintenance-authority.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { LEGACY_PARTICIPANTS_SCHEMA } from "../state/openclaw-agent-schema-history.js";
import { seedOpenClawAgentSchemaV21 } from "../state/openclaw-agent-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { prepareTrajectoryPayload } from "../trajectory/runtime-payload.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  encodeArchiveContent,
  TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE,
} from "./state-migrations.transcript-directives-archives.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";
import {
  type FixtureEvent,
  compressTranscriptRows,
  insertArchive,
  insertSession,
  messageEvent,
  readDatabaseRow,
  readEventJson,
  readGeneration,
  readMigrationCursor,
  textEvent,
  writeArchiveCopy,
  writeMetadata,
} from "./state-migrations.transcript-directives.test-support.js";

const tempDirs: string[] = [];
const NO_CHANGES = { changes: [], warnings: [] };
const archivesCursor = (sessionId = "", generation = "") => ({
  generation,
  phase: "archives",
  scope: "all",
  sessionId,
  version: 2,
});

function openLegacyAgentDatabase(stateDir: string, agentId = "main") {
  // These active stores have known-empty deletion history before their legacy bytes exist.
  openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const databasePath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = openNodeSqliteDatabase(databasePath);
  seedOpenClawAgentSchemaV21(database, agentId);
  removeCanonicalValidationFromHistoricalAgentFixture(database);
  database.exec(`
    DROP TABLE session_participants;
    ${LEGACY_PARTICIPANTS_SCHEMA}
    PRAGMA user_version = 17;
    UPDATE schema_meta SET schema_version = 17 WHERE meta_key = 'primary';
  `);
  return { db: database, path: databasePath };
}

function hasTranscriptArchivesTable(databasePath: string): boolean {
  return Boolean(
    readDatabaseRow(
      databasePath,
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
      "session_transcript_archives",
    ),
  );
}

function fixture() {
  const stateDir = makeTempDir(tempDirs, "transcript-directive-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const opened = openOpenClawAgentDatabase({ agentId: "main", env });
  return {
    stateDir,
    env,
    opened,
    databasePath: opened.path,
    read: (session: string, seq: number) => readEventJson(opened.path, session, seq),
    database: requireNativeSqliteDatabase(opened.db),
  };
}

function seedSessions(
  database: Parameters<typeof insertSession>[0],
  sessions: Record<string, FixtureEvent[]>,
  storage: string,
) {
  for (const [name, events] of Object.entries(sessions)) {
    if (storage === "zstd") {
      for (const event of events) {
        event.fixturePadding = "compression fixture ".repeat(256);
      }
    }
    insertSession(database, { events, generation: `${name}-before`, sessionId: `${name}-session` });
  }
  if (storage === "zstd") {
    compressTranscriptRows(database);
  }
}

function competingWriter(stateDir: string, env: NodeJS.ProcessEnv) {
  // Bind before maintenance so this competing task cannot inherit its authority.
  const claim = AsyncResource.bind(claimOpenClawAgentDatabaseLease);
  return () =>
    claim({ agentId: "competitor", path: path.join(stateDir, "competitor.sqlite"), env });
}

function expireMaintenance(env: NodeJS.ProcessEnv) {
  openOpenClawStateDatabase({ env })
    .db.prepare("UPDATE state_leases SET expires_at = ? WHERE scope = ? AND lease_key = ?")
    .run(
      Date.now() - 1,
      AGENT_DATABASE_MAINTENANCE_LEASE.scope,
      AGENT_DATABASE_MAINTENANCE_LEASE.key,
    );
}

function parseArchive(content: string): FixtureEvent[] {
  return content
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureEvent);
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("historical transcript directive migration", () => {
  it.each(["identity", "zstd"])(
    "migrates %s assistant rows and archives while preserving code and derived indexes",
    async (storage) => {
      const { env, database, databasePath } = fixture();
      const tagged = textEvent(
        "tagged-assistant",
        "[[reply_to_current]]\n[[reply_to: message-7 ]]\n[[audio_as_voice]]\nFinal answer [[react: 👍]]",
        10,
      );
      const user = messageEvent({
        id: "user-marker",
        parentId: "tagged-assistant",
        role: "user",
        timestamp: 11,
        content: "Keep [[reply_to_current]] and [[react: 👍]]",
      });
      const tool = textEvent(
        "tool-marker",
        "Keep [[audio_as_voice]]",
        12,
        "toolResult",
        "user-marker",
      );
      const codeText = [
        "Use `[[reply_to_current]]` and `[[react: 👍]]` literally.",
        "```text",
        "[[audio_as_voice]]",
        "[[react_to_current: ✅]]",
        "```",
      ].join("\n");
      const code = textEvent("code-assistant", codeText, 20);
      const reaction = textEvent(
        "reaction-assistant",
        "Reacted [[react_to_current: ✅]] without a fact",
        30,
      );
      seedSessions(
        database,
        {
          tagged: [tagged, user, tool],
          code: [code],
          reaction: [reaction],
        },
        storage,
      );

      const archivedTagged = textEvent(
        "archived-tagged",
        "[[reply_to: archive-2]] Archived answer",
        40,
      );
      const archivedCode = textEvent("archived-code", "`[[reply_to_current]]`", 41);
      const archivedUser = messageEvent({
        id: "archived-user",
        role: "user",
        timestamp: 42,
        content: "[[audio_as_voice]]",
      });
      const archiveContent = `${[archivedTagged, archivedCode, archivedUser]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`;
      const archiveBytes = Buffer.from(archiveContent, "utf8");
      const archiveName = "archived-session.jsonl.deleted.2026-01-01T00-00-00.000Z.archive-gen";
      insertArchive(database, archiveBytes, archiveName, "archived-session", {
        generation: "archive-gen",
        createdAt: 40,
        publishedAt: 50,
      });
      const archivePath = writeArchiveCopy(databasePath, archiveName, archiveBytes);

      const codeEventJson = JSON.stringify(code);
      const userEventJson = JSON.stringify(user);
      const toolEventJson = JSON.stringify(tool);
      const archivedCodeJson = JSON.stringify(archivedCode);
      const archivedUserJson = JSON.stringify(archivedUser);
      closeOpenClawAgentDatabasesForTest();

      const result = await migrateHistoricalTranscriptDirectives({ env });
      expect(result.warnings).toEqual([]);
      expect(result.changes).toHaveLength(2);
      const recoveryDirectories = () =>
        fs
          .readdirSync(path.dirname(databasePath))
          .filter((name) => name.startsWith("openclaw-transcript-directives-recovery-"));
      const backups = recoveryDirectories();
      expect(backups).toHaveLength(1);
      const backupPath = path.join(path.dirname(databasePath), backups[0]!, "database.sqlite");
      expect(readEventJson(backupPath, "tagged-session", 0)).toBe(JSON.stringify(tagged));
      expect(readEventJson(backupPath, "reaction-session", 0)).toBe(JSON.stringify(reaction));
      expect(
        readDatabaseRow(backupPath, "SELECT archive_blob FROM session_transcript_archives"),
      ).toEqual({ archive_blob: new Uint8Array(archiveBytes) });

      const migratedTagged = JSON.parse(readEventJson(databasePath, "tagged-session", 0)) as {
        message: Record<string, unknown>;
      };
      expect(migratedTagged.message).toMatchObject({
        content: [{ type: "text", text: "Final answer" }],
        openclawDelivery: {
          audioAsVoice: true,
          replyToId: "message-7",
        },
      });
      expect(readEventJson(databasePath, "tagged-session", 1)).toBe(userEventJson);
      expect(readEventJson(databasePath, "tagged-session", 2)).toBe(toolEventJson);
      expect(readEventJson(databasePath, "code-session", 0)).toBe(codeEventJson);
      const migratedReaction = JSON.parse(readEventJson(databasePath, "reaction-session", 0)) as {
        message: Record<string, unknown>;
      };
      expect(migratedReaction.message).toMatchObject({
        content: [{ type: "text", text: "Reacted  without a fact" }],
      });
      expect(migratedReaction.message).not.toHaveProperty("openclawDelivery");

      expect(readGeneration(databasePath, "tagged-session")).not.toBe("tagged-before");
      expect(readGeneration(databasePath, "reaction-session")).not.toBe("reaction-before");
      expect(readGeneration(databasePath, "code-session")).toBe("code-before");

      expect(
        readDatabaseRow(
          databasePath,
          "SELECT session_id FROM session_transcript_fts WHERE session_transcript_fts MATCH ? AND session_id = ?",
          "Final",
          "tagged-session",
        ),
      ).toEqual({ session_id: "tagged-session" });
      const archivedRow = readDatabaseRow(
        databasePath,
        "SELECT archive_blob,archive_sha256 FROM session_transcript_archives WHERE session_id = ?",
        "archived-session",
      ) as { archive_blob: Uint8Array; archive_sha256: string };
      expect(createHash("sha256").update(archivedRow.archive_blob).digest("hex")).toBe(
        archivedRow.archive_sha256,
      );
      const migratedArchiveContent = Buffer.from(archivedRow.archive_blob).toString("utf8");
      const migratedArchive = parseArchive(migratedArchiveContent);
      expect(migratedArchive[0]).toMatchObject({
        message: {
          content: [{ type: "text", text: "Archived answer" }],
          openclawDelivery: { replyToId: "archive-2" },
        },
      });
      expect(migratedArchiveContent).toContain(archivedCodeJson);
      expect(migratedArchiveContent).toContain(archivedUserJson);
      expect(readSessionArchiveContentSync(archivePath)).toBe(migratedArchiveContent);

      const generationsAfterFirstRun = {
        tagged: readGeneration(databasePath, "tagged-session"),
        reaction: readGeneration(databasePath, "reaction-session"),
      };
      const archiveBytesAfterFirstRun = fs.readFileSync(archivePath);
      await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual(NO_CHANGES);
      expect(readGeneration(databasePath, "tagged-session")).toBe(generationsAfterFirstRun.tagged);
      expect(readGeneration(databasePath, "reaction-session")).toBe(
        generationsAfterFirstRun.reaction,
      );
      expect(fs.readFileSync(archivePath)).toEqual(archiveBytesAfterFirstRun);
      expect(recoveryDirectories()).toEqual(backups);
    },
  );

  it("completes a pre-stuck archives cursor when the optional table is absent", async () => {
    const { env, opened, database, databasePath } = fixture();
    opened.db.exec("DROP TABLE session_transcript_archives");
    writeMetadata(database, archivesCursor());
    closeOpenClawAgentDatabasesForTest();

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual(NO_CHANGES);
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
    expect(hasTranscriptArchivesTable(databasePath)).toBe(false);
  });

  it.each(["schema", "transcript", "archive"] as const)(
    "fences the %s write when maintenance expires at its commit boundary",
    async (scope) => {
      const { stateDir, env, opened, database, databasePath } = fixture();
      const event = textEvent("assistant-expired", "[[reply_to_current]] Migrating");
      const archiveBytes = Buffer.from(`${JSON.stringify(event)}\n`);
      const archiveCursor = archivesCursor();
      let archivePath = "";
      if (scope === "schema") {
        opened.db.exec(`
          DROP TRIGGER session_conversations_route_context_invalidate_after_update;
          ALTER TABLE session_conversations DROP COLUMN route_context_json;
        `);
      } else if (scope === "transcript") {
        insertSession(database, {
          events: [event],
          generation: "before",
          sessionId: "session-expired",
        });
      } else {
        const name = "expired.jsonl.deleted.2026-01-01T00-00-00.000Z.generation";
        insertArchive(database, archiveBytes, name, "archived-expired", { publishedAt: 1 });
        writeMetadata(database, archiveCursor);
        archivePath = writeArchiveCopy(databasePath, name, archiveBytes);
      }
      const originalEventJson =
        scope === "transcript" ? readEventJson(databasePath, "session-expired", 0) : undefined;
      closeOpenClawAgentDatabasesForTest();
      const claimCompetingLease = competingWriter(stateDir, env);
      let competingLeaseId: string | undefined;
      const revoke = () => {
        expireMaintenance(env);
        competingLeaseId = claimCompetingLease();
      };
      const agentLease = await import("../state/openclaw-agent-db-lease.js");
      const maintenance = await import("../state/openclaw-agent-db-maintenance-authority.js");
      const originalSchemaAssert = agentLease.assertAgentDatabaseMaintenanceAuthorityIfPresent;
      const originalAssert = assertAgentDatabaseMaintenanceAuthority;
      let assertions = 0;
      const authority =
        scope === "schema"
          ? vi
              .spyOn(agentLease, "assertAgentDatabaseMaintenanceAuthorityIfPresent")
              .mockImplementation(() => {
                revoke();
                originalSchemaAssert();
              })
          : vi
              .spyOn(maintenance, "assertAgentDatabaseMaintenanceAuthority")
              .mockImplementation(() => {
                if (scope === "transcript") {
                  originalAssert();
                  if (++assertions === 1) {
                    revoke();
                  }
                } else {
                  if (!competingLeaseId && new Error().stack?.includes("beforeRename")) {
                    revoke();
                  }
                  originalAssert();
                }
              });
      const result = await migrateHistoricalTranscriptDirectives({ env }).finally(() =>
        authority.mockRestore(),
      );
      expect(competingLeaseId).toBeDefined();
      if (scope === "schema") {
        expect(result.warnings.some((warning) => warning.includes("maintenance lease"))).toBe(true);
      } else {
        if (scope === "transcript") {
          expect(result.warnings).toHaveLength(2);
        } else {
          expect(result.warnings.length).toBeGreaterThanOrEqual(1);
        }
        expect(
          result.warnings.every(
            (warning) => warning.includes("maintenance lease") && warning.includes("was lost"),
          ),
        ).toBe(true);
      }
      if (scope === "archive") {
        expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
        expect(readMigrationCursor(databasePath)).toEqual(archiveCursor);
      } else {
        using stored = openNodeSqliteDatabase(databasePath, { readOnly: true });
        if (scope === "schema") {
          expect(
            stored
              .prepare(
                "SELECT 1 FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
              )
              .get(),
          ).toBeUndefined();
          expect(stored.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
          });
          expect(
            stored
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'session_conversations_route_context_invalidate_after_update'",
              )
              .get(),
          ).toBeUndefined();
        } else {
          expect(readEventJson(databasePath, "session-expired", 0)).toBe(originalEventJson);
          expect(
            stored
              .prepare("SELECT 1 FROM schema_meta WHERE meta_key = ?")
              .get("historical-transcript-directives-v1"),
          ).toBeUndefined();
        }
      }
      releaseOpenClawAgentDatabaseLease(competingLeaseId as string, { env });
    },
  );

  it("surfaces lease inspection failures from preflight", async () => {
    const { env, databasePath } = fixture();
    closeOpenClawAgentDatabasesForTest();
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    vi.spyOn(agentDatabaseLease, "assertNoOpenClawAgentDatabaseLeasesReadOnly").mockImplementation(
      () => {
        throw new Error("shared-state lease inspection failed");
      },
    );

    const result = await migrateHistoricalTranscriptDirectives({ env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped historical transcript directive migration: Error: shared-state lease inspection failed",
      ),
    ]);
    expect(readMigrationCursor(databasePath)).toBeUndefined();
  });

  it("leaves canonical archives and their active writer untouched", async () => {
    const { env, opened, database } = fixture();
    const archived = textEvent("archived-canonical", "Already canonical");
    const archiveBytes = Buffer.from(`${JSON.stringify(archived)}\n`, "utf8");
    insertArchive(
      database,
      archiveBytes,
      "canonical.jsonl.deleted.2026-01-01T00-00-00.000Z.generation",
      "archived-canonical",
    );

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual(NO_CHANGES);

    expect(opened.db.isOpen).toBe(true);
    expect(
      opened.db
        .prepare("SELECT 1 FROM schema_meta WHERE meta_key = ?")
        .get("historical-transcript-directives-v1"),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "defers idle bookkeeping but keeps actual legacy repair exclusive (legacy=%s)",
    async (legacy) => {
      const { env, database, databasePath } = fixture();
      const event = textEvent(
        "idle-assistant",
        legacy ? "[[reply_to_current]] repair" : "Canonical",
      );
      insertSession(database, {
        events: [event],
        generation: "before",
        sessionId: "idle-session",
        legacy,
      });
      const active = openOpenClawAgentDatabase({ agentId: "active", env });
      closeOpenClawAgentDatabasesForTest();
      const leaseId = claimOpenClawAgentDatabaseLease({
        agentId: "active",
        path: active.path,
        env,
      });

      const result = await migrateHistoricalTranscriptDirectives({ env }).finally(() =>
        releaseOpenClawAgentDatabaseLease(leaseId, { env }),
      );

      if (legacy) {
        expect(result.warnings).toEqual([expect.stringContaining("still open")]);
      } else {
        expect(result).toEqual(NO_CHANGES);
      }
      expect(readMigrationCursor(databasePath)).toBeUndefined();
      expect(JSON.parse(readEventJson(databasePath, "idle-session", 0))).toEqual(event);
    },
  );

  it("continues preflight after an unreadable target", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-preflight-targets-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openLegacyAgentDatabase(stateDir, "second");
    const databasePath = opened.path;
    const unreadablePath = path.join(stateDir, "unreadable", "agent.sqlite");
    fs.mkdirSync(path.dirname(unreadablePath), { recursive: true });
    fs.writeFileSync(unreadablePath, "not a sqlite database");
    opened.db.close();

    const result = await migrateHistoricalTranscriptDirectives({
      env,
      configuredAgentDatabaseTargets: [
        { agentId: "first", path: unreadablePath },
        { agentId: "second", path: databasePath },
      ],
    });

    expect(result.warnings.some((warning) => warning.includes("preflight"))).toBe(true);
    expect(readDatabaseRow(databasePath, "PRAGMA user_version")?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  });

  it("prunes a stale writer lease before completing an empty database", async () => {
    const { env, databasePath } = fixture();
    closeOpenClawAgentDatabasesForTest();
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: databasePath,
      env,
    });
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE agent_database_leases SET owner_pid = ? WHERE lease_id = ?")
      .run(2_147_483_647, leaseId);

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual(NO_CHANGES);
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
  });

  it("renews maintenance through a blocked schema upgrade and fences the final transcript batch", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-lease-renewal-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openLegacyAgentDatabase(stateDir);
    const batchSize = TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE;
    const sessionIdAt = (index: number) =>
      `session-${String(index).padStart(String(batchSize).length, "0")}`;
    for (let index = 0; index <= batchSize; index += 1) {
      insertSession(requireNativeSqliteDatabase(opened.db), {
        events: [textEvent(`assistant-${index}`, "[[reply_to_current]] Migrating", index + 1)],
        generation: "before",
        sessionId: sessionIdAt(index),
        reconcile: false,
        legacy: true,
      });
    }
    opened.db.close();

    const stateLease = await import("../state/openclaw-state-lease.js");
    const withLease = stateLease.withOpenClawStateLease;
    vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementationOnce((options, operation) =>
      withLease({ ...options, leaseMs: 1_000 }, operation),
    );
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const originalRenew = agentDatabaseLease.renewAgentDatabaseMaintenanceAuthorityIfPresent;
    let originalExpiresAt = 0;
    vi.spyOn(
      agentDatabaseLease,
      "renewAgentDatabaseMaintenanceAuthorityIfPresent",
    ).mockImplementationOnce(() => {
      originalExpiresAt = Number(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
          .get(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key)
          ?.expires_at,
      );
      // Parent fake timers cannot control the real heartbeat Worker.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_250);
      originalRenew();
    });

    let competingWriterError: unknown;
    const claimCompetingLease = competingWriter(stateDir, env);
    let competingLeaseId: string | undefined;
    let cursorAtCompetition: unknown;
    let competedAt = 0;
    const batchCursor = {
      phase: "transcripts",
      scope: "all",
      sessionId: sessionIdAt(batchSize - 1),
      version: 2,
    };
    const scheduleImmediate = globalThis.setImmediate;
    vi.spyOn(globalThis, "setImmediate").mockImplementation((callback, ...args) =>
      scheduleImmediate(() => {
        if (!competedAt && isDeepStrictEqual(readMigrationCursor(opened.path), batchCursor)) {
          cursorAtCompetition = readMigrationCursor(opened.path);
          competedAt = Date.now();
          try {
            competingLeaseId = claimCompetingLease();
          } catch (error) {
            competingWriterError = error;
          }
        }
        callback(...args);
      }),
    );

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toMatchObject({
      warnings: [],
    });

    expect(originalExpiresAt).toBeGreaterThan(0);
    expect(competedAt).toBeGreaterThan(originalExpiresAt);
    expect(cursorAtCompetition).toEqual(batchCursor);
    expect(competingWriterError).toEqual(
      expect.objectContaining({ message: expect.stringContaining("maintenance is in progress") }),
    );
    expect(competingLeaseId).toBeUndefined();
    expect(readMigrationCursor(opened.path)).toEqual({ phase: "complete", version: 2 });
    expect(JSON.parse(readEventJson(opened.path, sessionIdAt(batchSize), 0))).toMatchObject({
      message: { content: [{ type: "text", text: "Migrating" }] },
    });
    expect(readDatabaseRow(opened.path, "PRAGMA user_version")?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "competitor",
      path: path.join(stateDir, "competitor.sqlite"),
      env,
    });
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
  });
});

it.each([
  { copyMissing: false, cursorPhase: "complete" },
  { copyMissing: true, cursorPhase: "complete" },
  { copyMissing: false, cursorPhase: "archives" },
  { copyMissing: true, cursorPhase: "archives" },
] as const)(
  "recovers a pending archive with a $cursorPhase cursor (copy missing: $copyMissing)",
  async ({ copyMissing, cursorPhase }) => {
    const { env, opened, database, databasePath } = fixture();
    const archiveBytes = Buffer.from(
      `${JSON.stringify({ type: "message", message: { role: "user", content: "clean" } })}\n`,
    );
    const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
    const archive = (sessionId: string, publishedAt: number | null) =>
      insertArchive(database, archiveBytes, `${sessionId}.jsonl`, sessionId, {
        createdAt: 40,
        publishedAt,
      });
    archive("complete-recovery", null);
    const metadata = (key: string, value: unknown) => writeMetadata(database, value, key);
    metadata(
      "historical-transcript-directives-v1",
      cursorPhase === "complete"
        ? { phase: "complete", version: 2 }
        : archivesCursor("complete-recovery", "generation"),
    );
    metadata("historical-canonical-transcript-archive-recovery-v1", {
      rows: [
        {
          sessionId: "complete-recovery",
          generation: "generation",
          nextSha256: archiveHash,
          publishedAt: 50,
        },
      ],
    });
    const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
      agentId: "main",
      path: opened.path,
    });
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const archivePath = path.join(archiveDirectory, "complete-recovery.jsonl");
    if (!copyMissing) {
      fs.writeFileSync(archivePath, Buffer.from("stale file"));
    }
    if (cursorPhase === "archives") {
      archive("later-recovery", 60);
      fs.writeFileSync(path.join(archiveDirectory, "later-recovery.jsonl"), archiveBytes);
    }
    closeOpenClawAgentDatabasesForTest();

    const first = await migrateHistoricalTranscriptDirectives({ env });
    if (copyMissing) {
      const expectedWarnings = [
        expect.stringContaining("Missing 1 canonical transcript archive file(s)"),
        `Missing canonical transcript archive copy: ${archivePath}`,
      ];
      expect(first.warnings).toEqual(expectedWarnings);
      expect((await migrateHistoricalTranscriptDirectives({ env })).warnings).toEqual(
        expectedWarnings,
      );
      fs.writeFileSync(archivePath, Buffer.from("stale file"));
      expect((await migrateHistoricalTranscriptDirectives({ env })).warnings).toEqual([]);
    } else {
      expect(first.warnings).toEqual([]);
    }
    using recovered = openNodeSqliteDatabase(databasePath, { readOnly: true });
    const readMeta = (key: string) =>
      recovered.prepare("SELECT app_version FROM schema_meta WHERE meta_key = ?").get(key);
    expect(
      recovered
        .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
        .get("complete-recovery")?.published_at,
    ).toBe(50);
    expect(readMeta("historical-canonical-transcript-archive-recovery-v1")).toBeUndefined();
    expect(
      JSON.parse(String(readMeta("historical-transcript-directives-v1")?.app_version)),
    ).toEqual({ phase: "complete", version: 2 });
    expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
  },
);

const MASKED = '"provider":"***"';
const copilotFact = { modelId: "claude-opus-5.5", provider: "github-copilot" };
const restored = (event: FixtureEvent, provider = "github-copilot") =>
  JSON.stringify(event).replace(MASKED, `"provider":"${provider}"`);
function singleSession(content?: string, sessionId = "session") {
  const context = fixture();
  const masked = maskedAssistant("masked", copilotFact.modelId, 1);
  const tagged =
    content === undefined ? undefined : makeEvent("tagged", 2, "assistant", text(content));
  insertSession(context.database, {
    events: tagged ? [masked, tagged] : [masked],
    generation: "g",
    sessionId,
  });
  insertTrajectory(context.database, sessionId, [copilotFact]);
  return { ...context, masked, tagged };
}

function makeEvent(id: string, timestamp: number, role: "assistant" | "user", content: unknown) {
  return messageEvent({ id, timestamp, role, content });
}
const text = (value: string) => [{ type: "text", text: value }];
function maskedAssistant(id: string, model: string, timestamp: number): FixtureEvent {
  const result = makeEvent(id, timestamp, "assistant", text(`Answer ${id}`));
  Object.assign(result.message as Record<string, unknown>, { model, provider: "***" });
  return result;
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
    const data = {
      messagesSnapshot: [{ role: "user", content: "retained payload ".repeat(256) }],
    };
    const eventJson = JSON.stringify({
      type: "model.completed",
      sessionId,
      ...fact,
      ...(mixedStorage ? { data } : {}),
    });
    const payload =
      mixedStorage && seq % 2 === 0 ? prepareTrajectoryPayload(database, eventJson) : null;
    if (payload) {
      expect(payload.event_codec).not.toBeNull();
    }
    insert.run(
      sessionId,
      seq,
      "run",
      payload ? payload.event_json : eventJson,
      seq,
      payload?.event_payload ?? null,
      payload?.event_codec ?? null,
      payload?.event_utf8_bytes ?? null,
    );
  }
}

it.each(["identity", "zstd"])(
  "restores %s masked providers from recorded session facts and leaves ambiguity masked",
  async (storage) => {
    const { env, databasePath, database, read } = fixture();
    const copilot = maskedAssistant("copilot", "claude-opus-5.5", 1);
    const user = makeEvent("user", 2, "user", "next");
    const openai = maskedAssistant("openai", "gpt-6.1-sol", 3);
    // A masked-looking value outside message.provider is not a candidate.
    const toolCall = makeEvent("tool-call", 4, "assistant", [
      { type: "toolCall", id: "call", name: "probe", arguments: { provider: "***" } },
    ]);
    const ambiguous = maskedAssistant("ambiguous", "claude-opus-5.5", 5);
    const unrecorded = maskedAssistant("unrecorded", "claude-opus-5.5", 6);
    const sessions = {
      multi: [copilot, user, openai, toolCall],
      ambiguous: [ambiguous],
      unrecorded: [unrecorded],
      archived: [],
    };
    seedSessions(database, sessions, storage);
    insertTrajectory(
      database,
      "multi-session",
      [
        copilotFact,
        copilotFact,
        { modelId: "gpt-6.1-sol", provider: "openai" },
        { modelId: "gpt-6.1-sol", provider: "***" },
      ],
      storage === "zstd",
    );
    insertTrajectory(
      database,
      "ambiguous-session",
      [copilotFact, { modelId: "claude-opus-5.5", provider: "openrouter" }],
      storage === "zstd",
    );
    insertTrajectory(database, "archived-session", [copilotFact], storage === "zstd");
    const archived = maskedAssistant("archived", "claude-opus-5.5", 7);
    const archivedUser = makeEvent("a-user", 8, "user", "hi");
    const archiveContent = `${JSON.stringify(archived)}\n${JSON.stringify(archivedUser)}\n`;
    const archiveEncoding = storage === "zstd" ? "zstd" : "identity";
    const archiveBytes = encodeArchiveContent(archiveContent, archiveEncoding, "fixture");
    const archiveName = `archived-session.jsonl.deleted.2026-01-01T00-00-00.000Z.archive-gen${archiveEncoding === "zstd" ? SESSION_ARCHIVE_ZSTD_SUFFIX : ""}`;
    insertArchive(database, archiveBytes, archiveName, "archived-session", {
      generation: "archive-gen",
      encoding: archiveEncoding,
      createdAt: 7,
      publishedAt: 8,
    });
    const archivePath = writeArchiveCopy(databasePath, archiveName, archiveBytes);
    closeOpenClawAgentDatabasesForTest();
    const result = await migrateHistoricalTranscriptDirectives({ env });
    expect(result).toMatchObject({
      changes: [
        `Restored masked provider on 3 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
        `Repaired historical transcripts in ${databasePath}: 1 active session(s), 1 archived transcript(s).`,
      ],
      warnings: [
        `Left 2 historical transcript row(s) with masked provider "***" in ${databasePath}: no single provider was recorded for their session and model.`,
      ],
      warningDisposition: "recoverable",
    });
    expect([0, 1, 2, 3].map((seq) => read("multi-session", seq))).toEqual([
      restored(copilot),
      JSON.stringify(user),
      restored(openai, "openai"),
      JSON.stringify(toolCall),
    ]);
    expect(read("ambiguous-session", 0)).toBe(JSON.stringify(ambiguous));
    expect(read("unrecorded-session", 0)).toBe(JSON.stringify(unrecorded));
    expect(readGeneration(databasePath, "multi-session")).not.toBe("multi-before");
    expect(readGeneration(databasePath, "ambiguous-session")).toBe("ambiguous-before");
    const restoredArchive = `${restored(archived)}\n${JSON.stringify(archivedUser)}\n`;
    expect(readSessionArchiveContentSync(archivePath)).toBe(restoredArchive);
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
    const recorded = readDatabaseRow(
      databasePath,
      "SELECT app_version FROM schema_meta WHERE meta_key = ?",
      "historical-transcript-masked-provider-restored-v1",
    );
    expect(JSON.parse(String(recorded?.app_version))).toEqual({
      archiveLines: ["archived-session:archive-gen:1"],
      transcriptRows: { "multi-session": [0, 2] },
    });
    // Provider-only restoration leaves the already-current search index intact.
    expect(
      readDatabaseRow(
        databasePath,
        "SELECT needs_rebuild, indexed_seq FROM session_transcript_index_state WHERE session_id = ?",
        "multi-session",
      ),
    ).toEqual({ needs_rebuild: 0, indexed_seq: 3 });
    expect(
      fs
        .readdirSync(path.dirname(databasePath))
        .filter((name) => name.startsWith("openclaw-transcript-directives-recovery-")),
    ).toEqual([]);

    const archiveAfterFirstRun = fs.readFileSync(archivePath);
    const generationAfterFirstRun = readGeneration(databasePath, "multi-session");
    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual(NO_CHANGES);
    expect(readGeneration(databasePath, "multi-session")).toBe(generationAfterFirstRun);
    expect(fs.readFileSync(archivePath)).toEqual(archiveAfterFirstRun);
  },
);

it.each(["complete", "transcripts"])("resumes V1 %s provider repair", async (phase) => {
  const sessionId = "a-session";
  const content = phase === "complete" ? "[[reply_to_current]] kept" : undefined;
  const { env, databasePath, database, masked, tagged, read } = singleSession(content, sessionId);
  // Completed V1 already handled directives; interrupted V1 skipped earlier session ids.
  writeMetadata(database, phase === "complete" ? { phase } : { phase, sessionId: "z-session" });
  closeOpenClawAgentDatabasesForTest();
  const result = await migrateHistoricalTranscriptDirectives({ env });
  expect(result.warnings).toEqual([]);
  expect(result.changes).toContain(
    `Restored masked provider on 1 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
  );
  expect(read(sessionId, 0)).toBe(restored(masked));
  if (phase === "complete") {
    expect(read(sessionId, 1)).toBe(JSON.stringify(tagged));
  }
  expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
  await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
    changes: [],
    warnings: [],
  });
});

it("backs up and reindexes a session whose rows also need directive normalization", async () => {
  const { env, databasePath, masked, read } = singleSession("[[reply_to_current]] Final answer");
  closeOpenClawAgentDatabasesForTest();
  const result = await migrateHistoricalTranscriptDirectives({ env });
  expect(result.warnings).toEqual([]);
  expect(result.changes).toEqual([
    expect.stringMatching(/^Saved pre-repair SQLite backup: /u),
    `Restored masked provider on 1 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
    `Repaired historical transcripts in ${databasePath}: 1 active session(s), 0 archived transcript(s).`,
  ]);
  expect(read("session", 0)).toBe(restored(masked));
  expect(JSON.parse(read("session", 1))).toMatchObject({
    message: { content: [{ type: "text", text: "Final answer" }] },
  });
  using migrated = openNodeSqliteDatabase(databasePath, { readOnly: true });
  // Stripped directive text leaves the search index only through a rebuild.
  expect(
    migrated
      .prepare("SELECT 1 FROM session_transcript_fts WHERE session_transcript_fts MATCH ?")
      .all('"reply_to_current"'),
  ).toEqual([]);
});

it("leaves masked rows untouched while the agent database writer is active", async () => {
  const { env, databasePath, database, masked } = singleSession();
  writeMetadata(database, { phase: "complete" });
  closeOpenClawAgentDatabasesForTest();
  const leaseId = claimOpenClawAgentDatabaseLease({ agentId: "main", path: databasePath, env });
  const result = await migrateHistoricalTranscriptDirectives({ env }).finally(() => {
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
  });

  expect(result).toMatchObject({
    changes: [],
    warnings: [expect.stringContaining("database is still open in another process")],
  });
  expect(readEventJson(databasePath, "session", 0)).toBe(JSON.stringify(masked));
  expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete" });
});
