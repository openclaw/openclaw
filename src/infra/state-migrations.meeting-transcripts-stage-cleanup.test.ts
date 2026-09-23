import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  disposeLegacyMeetingTranscriptStage,
  openLegacyMeetingTranscriptStage,
} from "./state-migrations.meeting-transcripts-files.js";
import {
  detectLegacyMeetingTranscripts,
  migrateLegacyMeetingTranscripts,
} from "./state-migrations.meeting-transcripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

async function seedLegacySession(stateDir: string, sessionId: string): Promise<string> {
  const sessionDir = path.join(stateDir, "transcripts", "2026-07-01", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify({
      sessionId,
      title: "Design review",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-01T10:00:00.000Z",
      stoppedAt: "2026-07-01T10:30:00.000Z",
    })}\n`,
  );
  await fs.writeFile(
    path.join(sessionDir, "transcript.jsonl"),
    `${JSON.stringify({
      id: "u-1",
      sessionId,
      speaker: { label: "Alex" },
      text: "First line",
      final: true,
    })}\n`,
  );
  await fs.writeFile(path.join(sessionDir, "summary.md"), "# Design review\n\nFirst line.\n");
  return sessionDir;
}

describe("meeting transcript migration stage cleanup", () => {
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reports the completed import and archive when the stage file cannot be removed",
    async () => {
      const stateDir = tempDirs.make("openclaw-meeting-transcripts-cleanup-");
      const sourceDir = await seedLegacySession(stateDir, "design-review");
      const detected = detectLegacyMeetingTranscripts({
        stateDir,
        doctorOnlyStateMigrations: true,
      });

      let result: Awaited<ReturnType<typeof migrateLegacyMeetingTranscripts>>;
      try {
        result = await migrateLegacyMeetingTranscripts({
          detected,
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          stateDir,
          now: () => Date.parse("2026-07-02T00:00:00.000Z"),
          // Deny unlinking inside the state directory once the migration is
          // otherwise finished, the way an indexer or scanner holding the stage
          // file does on Windows.
          testHooks: { afterArchive: () => fsSync.chmodSync(stateDir, 0o555) },
        });
      } finally {
        fsSync.chmodSync(stateDir, 0o755);
      }

      expect(result.changes.join("\n")).toContain("1 utterance to shared SQLite state");
      expect(result.changes.join("\n")).toContain(
        `Archived legacy meeting transcript files → ${path.join(stateDir, "transcripts.migrated-2026-07-02T00-00-00-000Z")}`,
      );
      expect(
        result.warnings.filter((warning) =>
          warning.includes("Could not remove the disposable meeting transcript migration file"),
        ),
      ).not.toHaveLength(0);
      await expect(fs.stat(sourceDir)).rejects.toMatchObject({ code: "ENOENT" });
      // Doctor refuses the step, and with it every later repair, unless the result
      // marks its warnings recoverable (state-migrations.messages.ts:66).
      expect(result.warningDisposition).toBe("recoverable");
    },
  );

  it("turns a failed stage close into a warning instead of throwing", () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-cleanup-");
    const databasePath = path.join(stateDir, "stage.sqlite");
    const database = openLegacyMeetingTranscriptStage(databasePath);
    database.close();

    const warnings = disposeLegacyMeetingTranscriptStage({ database, databasePath });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "Could not close the meeting transcript migration stage database",
    );
    expect(fsSync.existsSync(databasePath)).toBe(false);
  });

  it("turns a failed stage removal into a warning instead of throwing", () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-cleanup-");
    const databasePath = path.join(stateDir, "stage.sqlite");
    fsSync.mkdirSync(databasePath);

    const warnings = disposeLegacyMeetingTranscriptStage({ databasePath });

    expect(warnings).toEqual([
      expect.stringContaining(
        `Could not remove the disposable meeting transcript migration file ${databasePath}`,
      ),
    ]);
  });
});
