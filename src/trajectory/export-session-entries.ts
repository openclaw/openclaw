// Trajectory session entry reader: loads exported session rows from SQLite or a
// legacy JSONL artifact through read-only session storage accessors.
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isSessionFileEntry,
  parseSessionFileEntriesWithWarnings,
} from "../agents/sessions/session-file-parser.js";
import type { FileEntry } from "../agents/sessions/session-manager.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  readTranscriptExportSnapshotReadOnlySync,
  type SessionTranscriptReadScope,
  type SessionTranscriptRuntimeTarget,
  type TranscriptEvent,
} from "../config/sessions/session-accessor.js";
import { readRestoredSessionTranscript } from "../config/sessions/session-cold-storage-read.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import type { TrajectoryBundleWarning } from "./types.js";

export type JsonlParseWarning = Omit<TrajectoryBundleWarning, "count" | "rows"> & {
  row: number;
};

type SessionEntryCandidateRow = {
  row: number;
  value: unknown;
};

export const MAX_TRAJECTORY_SESSION_FILE_BYTES = 50 * 1024 * 1024;

export function normalizeCompleteSessionTarget(
  target: SessionTranscriptRuntimeTarget | undefined,
): SessionTranscriptRuntimeTarget | undefined {
  if (!target) {
    return undefined;
  }
  const agentId = normalizeOptionalString(target.agentId);
  const sessionId = normalizeOptionalString(target.sessionId);
  const sessionKey = normalizeOptionalString(target.sessionKey);
  const storePath = normalizeOptionalString(target.storePath);
  return agentId && sessionId && sessionKey && storePath
    ? { agentId, sessionId, sessionKey, storePath }
    : undefined;
}

function formatSessionParseWarnings(
  warnings: ReturnType<typeof parseSessionFileEntriesWithWarnings>["warnings"],
): JsonlParseWarning[] {
  return warnings.map((warning) => ({
    source: "session",
    code: warning.code,
    row: warning.row,
    message:
      warning.code === "invalid-session-json"
        ? "Skipped a session JSONL row that is not valid JSON."
        : "Skipped a session JSONL row that is not a session entry object.",
  }));
}

function collectSessionEntries(
  rows: readonly SessionEntryCandidateRow[],
  warnings: JsonlParseWarning[] = [],
): {
  entries: FileEntry[];
  warnings: JsonlParseWarning[];
  rowByEntry: Map<FileEntry, number>;
} {
  const entries: FileEntry[] = [];
  const rowByEntry = new Map<FileEntry, number>();
  for (const row of rows) {
    if (!isSessionFileEntry(row.value)) {
      warnings.push({
        source: "session",
        code: "invalid-session-row",
        row: row.row,
        message: "Skipped a session JSONL row that is not a session entry object.",
      });
      continue;
    }
    entries.push(row.value);
    rowByEntry.set(row.value, row.row);
  }
  return { entries, warnings, rowByEntry };
}

async function loadTranscriptEventsForExport(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  const read = () => readTranscriptExportSnapshotReadOnlySync(scope)?.events ?? [];
  try {
    return read();
  } catch (error) {
    // Only an archived transcript needs the writable restore owner; hot exports
    // must not register a writer lease or rewrite database file modes.
    if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== scope.sessionId) {
      throw error;
    }
    return readRestoredSessionTranscript(scope, read);
  }
}

export async function readSessionEntries(params: {
  sessionFile?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  sessionId: string;
  sessionKey?: string;
}): Promise<{
  entries: FileEntry[];
  warnings: JsonlParseWarning[];
  rowByEntry: Map<FileEntry, number>;
}> {
  const completeTarget = normalizeCompleteSessionTarget(params.sessionTarget);
  if (completeTarget) {
    const targetKeyAgentId = parseAgentSessionKey(completeTarget.sessionKey)?.agentId;
    const targetKeyEntry = loadSessionEntryReadOnly({
      agentId: completeTarget.agentId,
      sessionKey: completeTarget.sessionKey,
      storePath: completeTarget.storePath,
    });
    // Export remains available after the session index row is pruned. A row
    // that still exists must agree with the artifact's complete target.
    if (
      completeTarget.sessionId !== params.sessionId ||
      (params.sessionKey !== undefined && completeTarget.sessionKey !== params.sessionKey) ||
      (targetKeyAgentId && targetKeyAgentId !== completeTarget.agentId) ||
      (targetKeyEntry && targetKeyEntry.sessionId !== completeTarget.sessionId)
    ) {
      throw new Error("Trajectory export transcript target does not match the requested session");
    }
    const events = await loadTranscriptEventsForExport({
      agentId: completeTarget.agentId,
      sessionId: completeTarget.sessionId,
      sessionKey: completeTarget.sessionKey,
      storePath: completeTarget.storePath,
      maxEventBytes: MAX_TRAJECTORY_SESSION_FILE_BYTES,
    });
    return collectSessionEntries(events.map((value, index) => ({ row: index + 1, value })));
  }
  const incompleteTarget = params.sessionTarget
    ? {
        agentId: normalizeOptionalString(params.sessionTarget.agentId),
        sessionId: normalizeOptionalString(params.sessionTarget.sessionId),
        sessionKey: normalizeOptionalString(params.sessionTarget.sessionKey),
        storePath: normalizeOptionalString(params.sessionTarget.storePath),
      }
    : undefined;
  if (!params.sessionFile) {
    throw new Error("Trajectory export requires a transcript identity or artifact file");
  }
  const marker = parseSqliteSessionFileMarker(params.sessionFile);
  if (!marker) {
    const { entries, warnings, rowByEntry } = parseSessionFileEntriesWithWarnings(
      await fsp.readFile(params.sessionFile, "utf8"),
    );
    return {
      entries,
      warnings: formatSessionParseWarnings(warnings),
      rowByEntry,
    };
  }
  if (marker.sessionId !== params.sessionId) {
    throw new Error("Trajectory export legacy marker does not match the requested session");
  }
  const targetKeyAgentId = parseAgentSessionKey(incompleteTarget?.sessionKey)?.agentId;
  const targetKeyEntry =
    incompleteTarget?.sessionKey && marker
      ? loadSessionEntryReadOnly({
          agentId: marker.agentId,
          sessionKey: incompleteTarget.sessionKey,
          storePath: marker.storePath,
        })
      : undefined;
  if (
    incompleteTarget &&
    ((incompleteTarget.agentId && incompleteTarget.agentId !== marker.agentId) ||
      (incompleteTarget.sessionId && incompleteTarget.sessionId !== marker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== marker.agentId) ||
      (incompleteTarget.sessionKey && targetKeyEntry?.sessionId !== marker.sessionId) ||
      (incompleteTarget.storePath &&
        path.resolve(incompleteTarget.storePath) !== path.resolve(marker.storePath)))
  ) {
    throw new Error("Trajectory export transcript target conflicts with the legacy marker");
  }
  const suppliedKeyEntry = params.sessionKey
    ? loadSessionEntryReadOnly({
        agentId: marker.agentId,
        sessionKey: params.sessionKey,
        storePath: marker.storePath,
      })
    : undefined;
  const markerMatches = listSessionEntriesReadOnly({
    agentId: marker.agentId,
    storePath: marker.storePath,
  }).filter(({ entry }) => entry.sessionId === marker.sessionId);
  if (suppliedKeyEntry && suppliedKeyEntry.sessionId !== marker.sessionId) {
    throw new Error("Trajectory export session key conflicts with the legacy marker");
  }
  if (params.sessionKey && !suppliedKeyEntry && markerMatches.length > 0) {
    throw new Error("Trajectory export session key is not mapped to the legacy marker");
  }
  const markerSessionKey = suppliedKeyEntry
    ? params.sessionKey
    : (resolvePreferredSessionKeyForSessionIdMatches(
        markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
        marker.sessionId,
      ) ?? (markerMatches.length === 0 ? params.sessionKey : undefined));
  if (!markerSessionKey && markerMatches.length > 0) {
    throw new Error("Trajectory export legacy marker session key is ambiguous");
  }
  return collectSessionEntries(
    (
      await loadTranscriptEventsForExport({
        agentId: marker.agentId,
        sessionId: marker.sessionId,
        ...(markerSessionKey ? { sessionKey: markerSessionKey } : {}),
        storePath: marker.storePath,
        maxEventBytes: MAX_TRAJECTORY_SESSION_FILE_BYTES,
      })
    ).map((value, index) => ({ row: index + 1, value })),
  );
}
