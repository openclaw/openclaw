// Doctor detection for legacy meeting transcript files and interrupted imports.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isRecordedCanonicalTranscriptExport } from "./state-migrations.meeting-transcripts-files.js";

export type LegacyMeetingTranscriptsDetection = {
  sourceDir: string;
  hasLegacy: boolean;
  pendingImportCount: number;
};

export type MeetingTranscriptMigrationDetectionState = {
  exportOwnership: Map<string, { manifest: Record<string, string>; pending: ReadonlySet<string> }>;
  pendingImportCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasLegacyArtifactsSync(directory: string): boolean {
  for (const name of ["metadata.json", "summary.json", "summary.md", "transcript.jsonl"]) {
    try {
      const stat = fs.lstatSync(path.join(directory, name));
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`legacy transcript source must be a regular file: ${directory}`);
      }
      return true;
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return false;
}

export function detectLegacyMeetingTranscripts(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): LegacyMeetingTranscriptsDetection {
  const sourceDir = path.join(params.stateDir, "transcripts");
  if (params.doctorOnlyStateMigrations !== true) {
    return { sourceDir, hasLegacy: false, pendingImportCount: 0 };
  }
  const databaseState = readMeetingTranscriptMigrationDetectionState({
    env: { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir },
  });
  const pendingImportCount = databaseState.pendingImportCount;
  try {
    const rootStat = fs.lstatSync(sourceDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`meeting transcript root must be a regular directory: ${sourceDir}`);
    }
    const dateEntries = fs.readdirSync(sourceDir, { withFileTypes: true });
    const sourceSelectors = hasLegacyArtifactsSync(sourceDir) ? ["."] : [];
    for (const dateEntry of dateEntries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) {
        continue;
      }
      if (dateEntry.isSymbolicLink()) {
        throw new Error(`legacy transcript date directory cannot be a symlink: ${dateEntry.name}`);
      }
      if (!dateEntry.isDirectory()) {
        continue;
      }
      const dateDir = path.join(sourceDir, dateEntry.name);
      if (hasLegacyArtifactsSync(dateDir)) {
        sourceSelectors.push(dateEntry.name);
      }
      for (const entry of fs.readdirSync(dateDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          throw new Error(`legacy transcript session cannot be a symlink: ${entry.name}`);
        }
        if (entry.isDirectory() && hasLegacyArtifactsSync(path.join(dateDir, entry.name))) {
          sourceSelectors.push(`${dateEntry.name}/${entry.name}`);
        }
      }
    }
    const hasSource = sourceSelectors.some((selector) => {
      const ownership = databaseState.exportOwnership.get(selector);
      return (
        !ownership ||
        !isRecordedCanonicalTranscriptExport({
          sessionDir: path.join(sourceDir, selector),
          manifest: ownership.manifest,
          pending: ownership.pending,
        })
      );
    });
    return {
      sourceDir,
      hasLegacy: hasSource || pendingImportCount > 0,
      pendingImportCount,
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { sourceDir, hasLegacy: pendingImportCount > 0, pendingImportCount };
    }
    throw error;
  }
}

export function readMeetingTranscriptMigrationDetectionState(params: {
  env: NodeJS.ProcessEnv;
}): MeetingTranscriptMigrationDetectionState {
  const databasePath = resolveOpenClawStateSqlitePath(params.env);
  if (!fs.existsSync(databasePath)) {
    return { exportOwnership: new Map(), pendingImportCount: 0 };
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = new Set(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('meeting_transcript_sessions', 'migration_sources')",
        )
        .all()
        .map((row) => String(row.name)),
    );
    const exportOwnership = new Map<
      string,
      { manifest: Record<string, string>; pending: ReadonlySet<string> }
    >();
    if (tables.has("meeting_transcript_sessions")) {
      const rows = database
        .prepare(
          "SELECT selector, export_manifest_json, export_pending_json FROM meeting_transcript_sessions",
        )
        .all();
      for (const row of rows) {
        const selector = String(row.selector);
        const parsed = JSON.parse(String(row.export_manifest_json)) as unknown;
        if (isRecord(parsed)) {
          exportOwnership.set(selector, {
            manifest: parsed as Record<string, string>,
            pending: new Set(JSON.parse(String(row.export_pending_json)) as string[]),
          });
        }
      }
    }
    const pendingRow = tables.has("migration_sources")
      ? (database
          .prepare(
            "SELECT COUNT(*) AS count FROM migration_sources WHERE migration_kind = ? AND status = ? AND removed_source = 0",
          )
          .get("meeting-transcripts-files-v1", "imported") as { count?: unknown } | undefined)
      : undefined;
    return {
      exportOwnership,
      pendingImportCount: typeof pendingRow?.count === "number" ? pendingRow.count : 0,
    };
  } finally {
    database.close();
  }
}
