import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
const removalWarning = "Could not remove the disposable meeting transcript migration file";
const stagePath = () =>
  path.join(tempDirs.make("openclaw-meeting-transcripts-cleanup-"), "stage.sqlite");
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

async function seedLegacySession(stateDir: string, sessionId: string): Promise<string> {
  const sessionDir = path.join(stateDir, "transcripts", "2026-07-01", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const writeJson = (name: string, value: unknown) =>
    fs.writeFile(path.join(sessionDir, name), `${JSON.stringify(value)}\n`);
  await writeJson("metadata.json", {
    sessionId,
    source: { providerId: "manual-transcript" },
    startedAt: "2026-07-01T10:00:00.000Z",
  });
  await writeJson("transcript.jsonl", { text: "First line" });
  return sessionDir;
}

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "reports the completed import and archive when the stage file cannot be removed",
  async () => {
    const stateDir = tempDirs.make("openclaw-meeting-transcripts-cleanup-");
    const sourceDir = await seedLegacySession(stateDir, "design-review");
    const detected = detectLegacyMeetingTranscripts({
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    const result = await migrateLegacyMeetingTranscripts({
      detected,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
      // Simulate a held stage file by denying unlink after import and archive.
      testHooks: { afterArchive: () => fsSync.chmodSync(stateDir, 0o555) },
    }).finally(() => fsSync.chmodSync(stateDir, 0o755));

    expect(result.changes.join("\n")).toContain("1 utterance to shared SQLite state");
    expect(result.changes.join("\n")).toContain(
      `Archived legacy meeting transcript files → ${path.join(stateDir, "transcripts.migrated-2026-07-02T00-00-00-000Z")}`,
    );
    expect(result.warnings).toContainEqual(expect.stringContaining(removalWarning));
    await expect(fs.stat(sourceDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.warningDisposition).toBe("recoverable");
  },
);

it("retains the live stage files when close fails and removes them after a successful close", () => {
  const databasePath = stagePath();
  using database = openLegacyMeetingTranscriptStage(databasePath);
  const files = [databasePath, `${databasePath}-shm`, `${databasePath}-wal`];
  const filesExist = () => files.map((file) => fsSync.existsSync(file));
  using close = vi.spyOn(database, "close").mockImplementationOnce(() => {
    throw new Error("native close failed");
  });
  expect(filesExist()).toEqual([true, true, true]);

  const warnings = disposeLegacyMeetingTranscriptStage({ database, databasePath });

  expect(warnings).toEqual([
    expect.stringContaining("Could not close the meeting transcript migration stage database"),
  ]);
  expect(filesExist()).toEqual([true, true, true]);
  expect(warnings[0]).toContain(`Left stage files in place at ${databasePath}`);
  expect(database.prepare("SELECT COUNT(*) AS count FROM staged_utterances").get()).toEqual({
    count: 0,
  });

  close.mockRestore();
  expect(disposeLegacyMeetingTranscriptStage({ database, databasePath })).toEqual([]);
  expect(database.isOpen).toBe(false);
  expect(filesExist()).toEqual([false, false, false]);
});

it("turns a failed stage removal into a warning", () => {
  const databasePath = stagePath();
  fsSync.mkdirSync(databasePath);

  const warnings = disposeLegacyMeetingTranscriptStage({ databasePath });
  expect(warnings).toEqual([expect.stringContaining(`${removalWarning} ${databasePath}`)]);
  expect(fsSync.existsSync(databasePath)).toBe(true);
});
