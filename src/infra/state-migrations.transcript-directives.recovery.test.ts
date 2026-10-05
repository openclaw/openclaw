import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("historical transcript directive archive recovery", () => {
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
      const archiveName = "complete-recovery.jsonl";
      opened.db
        .prepare(
          `INSERT INTO session_transcript_archives(
          session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "complete-recovery",
          "generation",
          "agent:main:complete-recovery",
          "deleted",
          "identity",
          archiveBytes,
          archiveHash,
          archiveName,
          40,
          null,
        );
      const insertMeta = opened.db.prepare(
        `INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
      );
      insertMeta.run(
        "historical-transcript-directives-v1",
        "agent",
        1,
        "main",
        JSON.stringify(
          cursorPhase === "complete"
            ? { phase: "complete" }
            : { phase: "archives", generation: "generation", sessionId: "complete-recovery" },
        ),
        1,
        1,
      );
      insertMeta.run(
        "historical-canonical-transcript-archive-recovery-v1",
        "agent",
        1,
        "main",
        JSON.stringify({
          rows: [
            {
              sessionId: "complete-recovery",
              generation: "generation",
              nextSha256: archiveHash,
              publishedAt: 50,
            },
          ],
        }),
        1,
        1,
      );
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
        agentId: "main",
        path: opened.path,
      });
      fs.mkdirSync(archiveDirectory, { recursive: true });
      const archivePath = path.join(archiveDirectory, archiveName);
      if (!copyMissing) {
        fs.writeFileSync(archivePath, Buffer.from("stale file"));
      }
      if (cursorPhase === "archives") {
        opened.db
          .prepare(
            `INSERT INTO session_transcript_archives(
              session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
              archive_name,created_at,published_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            "later-recovery",
            "generation",
            "agent:main:later-recovery",
            "deleted",
            "identity",
            archiveBytes,
            archiveHash,
            "later-recovery.jsonl",
            40,
            60,
          );
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
      const recovered = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(
          recovered
            .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
            .get("complete-recovery")?.published_at,
        ).toBe(50);
        expect(
          recovered
            .prepare("SELECT 1 FROM schema_meta WHERE meta_key = ?")
            .get("historical-canonical-transcript-archive-recovery-v1"),
        ).toBeUndefined();
        expect(
          JSON.parse(
            String(
              recovered
                .prepare("SELECT app_version FROM schema_meta WHERE meta_key = ?")
                .get("historical-transcript-directives-v1")?.app_version,
            ),
          ),
        ).toEqual({ phase: "complete" });
        expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
      } finally {
        recovered.close();
      }
    },
  );
});
