import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  { copyMissing: false, cursorPhase: "complete" },
  { copyMissing: true, cursorPhase: "complete" },
  { copyMissing: false, cursorPhase: "archives" },
  { copyMissing: true, cursorPhase: "archives" },
] as const)(
  "recovers a pending archive with a $cursorPhase cursor (copy missing: $copyMissing)",
  async ({ copyMissing, cursorPhase }) => {
    const stateDir = tempDirs.make("transcript-directive-complete-recovery-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const archiveBytes = Buffer.from(
      `${JSON.stringify({ type: "message", message: { role: "user", content: "clean" } })}\n`,
    );
    const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
    const insertArchive = opened.db.prepare(
      `INSERT INTO session_transcript_archives(
          session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at
        ) VALUES(?,'generation',?,'deleted','identity',?,?,?,40,?)`,
    );
    function archive(sessionId: string, publishedAt: number | null) {
      insertArchive.run(
        sessionId,
        `agent:main:${sessionId}`,
        archiveBytes,
        archiveHash,
        `${sessionId}.jsonl`,
        publishedAt,
      );
    }
    archive("complete-recovery", null);
    const insertMeta = opened.db.prepare(
      `INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    );
    const metadata = (key: string, value: unknown) =>
      insertMeta.run(key, "agent", 1, "main", JSON.stringify(value), 1, 1);
    metadata(
      "historical-transcript-directives-v1",
      cursorPhase === "complete"
        ? { phase: "complete", version: 2 }
        : {
            phase: "archives",
            generation: "generation",
            scope: "all",
            sessionId: "complete-recovery",
            version: 2,
          },
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
    const databasePath = opened.path;
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
