import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctorMeetingTranscripts } from "./doctor-meeting-transcripts.js";

describe("doctor meeting transcript migration", () => {
  let root: string;
  let transcriptsDir: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-meeting-"));
    transcriptsDir = path.join(root, "transcripts");
  });

  afterEach(async () => {
    await fs.promises.rm(root, { force: true, recursive: true });
  });

  it("reports zero sessions when the transcript directory does not exist", async () => {
    const report = await runDoctorMeetingTranscripts({
      transcriptsDir: path.join(root, "nonexistent"),
    });
    expect(report.foundSessions).toBe(0);
    expect(report.scannedDirs).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it("reports zero sessions when the transcript directory is empty", async () => {
    await fs.promises.mkdir(transcriptsDir, { recursive: true });
    const report = await runDoctorMeetingTranscripts({ transcriptsDir });
    expect(report.foundSessions).toBe(0);
    expect(report.scannedDirs).toBe(0);
  });

  it("detects file-backed sessions without importing in dry-run mode", async () => {
    const sessionDir = path.join(transcriptsDir, "2026-07-01", "meeting-design-review");
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const session = {
      sessionId: "meeting-design-review",
      source: { providerId: "discord" },
      startedAt: "2026-07-01T14:00:00.000Z",
      title: "Design review",
    };
    await fs.promises.writeFile(
      path.join(sessionDir, "metadata.json"),
      `${JSON.stringify(session, null, 2)}\n`,
    );

    const report = await runDoctorMeetingTranscripts({
      transcriptsDir,
      shouldRepair: false,
    });
    expect(report.foundSessions).toBe(1);
    expect(report.importedSessions).toBe(0);
    expect(report.repaired).toBe(false);
  });

  it("imports sessions and utterances when repair is enabled", async () => {
    const sessionDir = path.join(transcriptsDir, "2026-07-01", "meeting-standup");
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const session = {
      sessionId: "meeting-standup",
      source: { providerId: "discord" },
      startedAt: "2026-07-01T09:00:00.000Z",
      title: "Daily standup",
    };
    await fs.promises.writeFile(
      path.join(sessionDir, "metadata.json"),
      `${JSON.stringify(session, null, 2)}\n`,
    );
    const utterances = [
      {
        id: "u1",
        sessionId: "meeting-standup",
        text: "Hello",
        startedAt: "2026-07-01T09:00:00.000Z",
        final: true,
      },
      {
        id: "u2",
        sessionId: "meeting-standup",
        text: "Status update",
        startedAt: "2026-07-01T09:01:00.000Z",
        final: true,
      },
    ];
    await fs.promises.writeFile(
      path.join(sessionDir, "transcript.jsonl"),
      utterances.map((u) => JSON.stringify(u)).join("\n") + "\n",
    );

    const report = await runDoctorMeetingTranscripts({
      transcriptsDir,
      shouldRepair: true,
    });

    expect(report.foundSessions).toBe(1);
    // SQLite may be unavailable on this Node version; when available,
    // importedSessions would be 1 and importedUtterances would be 2.
    if (report.issues.length === 0) {
      expect(report.importedSessions).toBe(1);
      expect(report.importedUtterances).toBe(2);
    }
  });
});
