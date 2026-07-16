import fs from "node:fs";
import path from "node:path";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptUtterance,
} from "../transcripts/provider-types.js";
import { TranscriptsStore } from "../transcripts/store.js";

const MEETING_TRANSCRIPTS_CHECK_ID = "core/doctor/meeting-transcripts";

export type DoctorMeetingTranscriptsOptions = {
  transcriptsDir: string;
  shouldRepair?: boolean;
};

export type DoctorMeetingTranscriptsReport = {
  checkId: string;
  scannedDirs: number;
  foundSessions: number;
  importedSessions: number;
  importedUtterances: number;
  issues: string[];
  repaired: boolean;
};

function scanMeetingTranscriptDirs(rootDir: string): string[] {
  const dirs: string[] = [];
  try {
    const datedEntries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of datedEntries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
        continue;
      }
      const dateDir = path.join(rootDir, entry.name);
      const sessionDirs = fs.readdirSync(dateDir, { withFileTypes: true });
      for (const session of sessionDirs) {
        if (!session.isDirectory()) {
          continue;
        }
        const metadataPath = path.join(dateDir, session.name, "metadata.json");
        if (fs.existsSync(metadataPath)) {
          dirs.push(path.join(dateDir, session.name));
        }
      }
    }
  } catch {
    // Directory does not exist or cannot be read — no legacy data.
  }
  return dirs;
}

function readMetadataFile(sessionDir: string): TranscriptSessionDescriptor | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(sessionDir, "metadata.json"), "utf8"),
    ) as TranscriptSessionDescriptor;
  } catch {
    return undefined;
  }
}

function readUtterances(sessionDir: string): TranscriptUtterance[] {
  const transcriptPath = path.join(sessionDir, "transcript.jsonl");
  try {
    const raw = fs.readFileSync(transcriptPath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptUtterance);
  } catch {
    return [];
  }
}

export async function runDoctorMeetingTranscripts(
  options: DoctorMeetingTranscriptsOptions,
): Promise<DoctorMeetingTranscriptsReport> {
  const report: DoctorMeetingTranscriptsReport = {
    checkId: MEETING_TRANSCRIPTS_CHECK_ID,
    scannedDirs: 0,
    foundSessions: 0,
    importedSessions: 0,
    importedUtterances: 0,
    issues: [],
    repaired: false,
  };

  const sessionDirs = scanMeetingTranscriptDirs(options.transcriptsDir);
  report.scannedDirs = sessionDirs.length;

  if (sessionDirs.length === 0) {
    return report;
  }
  report.foundSessions = sessionDirs.length;

  if (!options.shouldRepair) {
    return report;
  }

  let stateDb: OpenClawStateDatabase | undefined;
  try {
    stateDb = openOpenClawStateDatabase({ env: process.env }) as OpenClawStateDatabase;
  } catch {
    report.issues.push("SQLite runtime unavailable; cannot import meeting transcripts");
    return report;
  }

  const sqliteStore = new TranscriptsStore(options.transcriptsDir, stateDb);

  for (const sessionDir of sessionDirs) {
    const session = readMetadataFile(sessionDir);
    if (!session) {
      report.issues.push(`Cannot read metadata.json in ${sessionDir}`);
      continue;
    }

    try {
      await sqliteStore.writeSession(session);
      report.importedSessions++;

      const utterances = readUtterances(sessionDir);
      for (const utterance of utterances) {
        await sqliteStore.appendUtteranceForSession(session, utterance);
        report.importedUtterances++;
      }
    } catch (err) {
      report.issues.push(
        `Failed to import session ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  report.repaired = options.shouldRepair && report.issues.length === 0;
  return report;
}
