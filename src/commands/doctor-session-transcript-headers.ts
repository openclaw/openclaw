import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isIndexedSessionEntry } from "../agents/sessions/session-manager-codec.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import {
  readTranscriptStorageRows,
  type SqliteTranscriptStorageRow,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
} from "../config/sessions/transcript-tree.js";
import { MIN_READABLE_SESSION_VERSION } from "../config/sessions/version.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { backupDoctorSqliteRepair } from "../infra/sqlite-index-recovery.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  scanDoctorSessionTranscripts,
  transcriptSnapshotsMatch,
} from "./doctor-session-transcript-scan.js";
import { countLabel } from "./doctor-state-integrity-format.js";

const NOTE_TITLE = "Session transcript headers";

type HeaderRepairContext = {
  sessionKey: string;
  spawnedCwd?: string;
};

function createCanonicalHeaderlessEventParser(sessionId: string) {
  const eventIds = new Set<string>([sessionId]);
  const events: TranscriptEvent[] = [];
  let indexedEntries = 0;
  return {
    events,
    hasIndexedEntries: () => indexedEntries > 0,
    parse(row: SqliteTranscriptStorageRow): Record<string, unknown> | undefined {
      let event: TranscriptEvent;
      try {
        event = JSON.parse(row.eventJson) as TranscriptEvent;
      } catch {
        return undefined;
      }
      if (!isRecord(event) || event.type === "session") {
        return undefined;
      }
      // Opaque plugin rows remain uninterpreted. Known entries and leaf controls
      // must already satisfy the runtime schema before a replacement can be lossless.
      if (isCanonicalSessionTranscriptEntry(event)) {
        if (!isIndexedSessionEntry(event)) {
          return undefined;
        }
        indexedEntries += 1;
      } else if (event.type === "leaf" && !isSessionTranscriptLeafControl(event)) {
        return undefined;
      }
      if (typeof event.id === "string") {
        const eventId = event.id.trim();
        if (!eventId || eventIds.has(eventId)) {
          return undefined;
        }
        eventIds.add(eventId);
      }
      events.push(event);
      return event;
    },
  };
}

function readHeaderRepairContext(
  database: OpenClawAgentDatabase,
  sessionId: string,
): HeaderRepairContext | undefined {
  const db = getSessionKysely(database.db);
  const window = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .leftJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select([
        "session_windows.session_key",
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
      ])
      .where("session_windows.session_id", "=", sessionId)
      .limit(1),
  );
  if (!window?.session_key) {
    return undefined;
  }
  let spawnedCwd: string | undefined;
  // Historical windows can share a key; only the node's current session owns entry_json.
  if (window.current_session_id === sessionId && window.entry_json) {
    try {
      const entry = JSON.parse(window.entry_json) as {
        sessionId?: unknown;
        spawnedCwd?: unknown;
      };
      if (
        entry.sessionId === sessionId &&
        typeof entry.spawnedCwd === "string" &&
        entry.spawnedCwd.trim()
      ) {
        spawnedCwd = entry.spawnedCwd.trim();
      }
    } catch {
      // The transcript can still be repaired with the configured agent workspace.
    }
  }
  return { sessionKey: window.session_key, ...(spawnedCwd ? { spawnedCwd } : {}) };
}

export async function noteSessionTranscriptHeaderHealth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  integrityCheck?: "quick" | "full";
}): Promise<{ found: number; repaired: number }> {
  const env = params.env ?? process.env;
  let found = 0;
  let repaired = 0;
  const preserved = new Set<string>();

  scanDoctorSessionTranscripts(
    {
      cfg: params.cfg,
      env,
      title: NOTE_TITLE,
      failureLabel: "Failed to inspect transcript headers",
      selectSessionIds: (reader, reportError) => reader.headerlessSessionIds(reportError),
    },
    ({ reader, target, databaseOptions, reportError, sessionId }) => {
      const sqlitePath = target.sqlitePath;
      const parser = createCanonicalHeaderlessEventParser(sessionId);
      const snapshot = reader.headerlessSnapshot(
        sessionId,
        (row) => parser.parse(row) !== undefined,
      );
      if (!snapshot.ok) {
        reportError(`- Failed to read transcript ${sessionId} (${target.agentId})`, snapshot.error);
        return;
      }
      if (!snapshot.sessionKey || !parser.hasIndexedEntries() || snapshot.rows.length === 0) {
        return;
      }
      const headerTimestamp = timestampMsToIsoString(snapshot.rows[0]?.createdAt ?? Number.NaN);
      if (!headerTimestamp) {
        note(
          `- Failed to repair transcript ${sessionId} (${target.agentId}): invalid first-row timestamp`,
          NOTE_TITLE,
        );
        return;
      }
      found += 1;
      if (!params.shouldRepair) {
        return;
      }

      const logicalAgentId = parseAgentSessionKey(snapshot.sessionKey)?.agentId ?? target.agentId;
      const workspaceCwd = resolveAgentWorkspaceDir(params.cfg, logicalAgentId, env);
      try {
        runOpenClawAgentWriteTransaction(
          (database) => {
            const currentRows = readTranscriptStorageRows(database, sessionId);
            if (!transcriptSnapshotsMatch(snapshot.rows, currentRows, true)) {
              throw new Error(`transcript changed while preparing header repair for ${sessionId}`);
            }
            const context = readHeaderRepairContext(database, sessionId);
            if (!context || context.sessionKey !== snapshot.sessionKey) {
              throw new Error(
                `session binding changed while preparing header repair for ${sessionId}`,
              );
            }
            const header = createSessionTranscriptHeader({
              // Retained headerless history keeps the legacy projection.
              version: MIN_READABLE_SESSION_VERSION,
              cwd: context.spawnedCwd ?? workspaceCwd,
              sessionId,
              timestamp: headerTimestamp,
            });
            if (!preserved.has(sqlitePath)) {
              const backup = backupDoctorSqliteRepair(sqlitePath, "transcript-headers");
              preserved.add(sqlitePath);
              note(`- Saved pre-repair SQLite backup: ${backup}`, NOTE_TITLE);
            }
            replaceSqliteTranscriptEventsInTransaction(
              database,
              {
                agentId: target.agentId,
                env,
                path: sqlitePath,
                sessionId,
                sessionKey: context.sessionKey,
              },
              [header, ...parser.events],
              {
                createdAtByIndex: [
                  currentRows[0]?.createdAt ?? Date.parse(headerTimestamp),
                  ...currentRows.map((row) => row.createdAt),
                ],
                preserveSessionWindowRecency: true,
              },
            );
          },
          databaseOptions,
          {
            operationLabel: "doctor.session-transcript-headers",
            repairAdmission: {
              integrityCheck: params.integrityCheck ?? "quick",
              integrityTables: [
                "transcript_events",
                "transcript_rewrite_watermarks",
                "session_windows",
                "session_transcript_index_state",
                "session_transcript_active_events",
                "session_transcript_fts_rows",
                "session_transcript_fts",
                "transcript_event_identities",
                "session_reactions",
                "session_nodes",
              ],
            },
          },
        );
        repaired += 1;
      } catch (error) {
        reportError(`- Failed to repair transcript ${sessionId} (${target.agentId})`, error);
      }
    },
  );

  if (params.shouldRepair && repaired > 0) {
    note(
      `- Prepended missing headers to ${countLabel(repaired, "session transcript")}.`,
      NOTE_TITLE,
    );
  } else if (!params.shouldRepair && found > 0) {
    note(
      [
        `- Found ${countLabel(found, "stored session transcript")} without a header.`,
        `- Run "openclaw doctor --fix" to repair ${found === 1 ? "it" : "them"} before resuming the session.`,
      ].join("\n"),
      NOTE_TITLE,
    );
  }

  return { found, repaired };
}
