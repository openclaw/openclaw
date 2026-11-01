import { note } from "../../packages/terminal-core/src/note.js";
import { INBOUND_CONTEXT_MARKER } from "../auto-reply/reply/inbound-context-marker.js";
import {
  mayContainLegacyInboundContextLabels,
  normalizeLegacyInboundContextLabels,
} from "../config/sessions/legacy-inbound-context-labels.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { backupDoctorSqliteRepair } from "../infra/sqlite-index-recovery.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { VERSION, resolveRuntimeServiceBuildId, resolveRuntimeServiceCommit } from "../version.js";
import {
  scanDoctorSessionTranscripts,
  transcriptSnapshotsMatch,
} from "./doctor-session-transcript-scan.js";
import { countLabel } from "./doctor-state-integrity-format.js";

const NOTE_TITLE = "Session transcript labels";

export async function noteSessionTranscriptLabelHealth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  integrityCheck?: "quick" | "full";
}): Promise<void> {
  const env = params.env ?? process.env;
  let foundSessions = 0;
  let foundEvents = 0;
  let repairedSessions = 0;
  let repairedEvents = 0;
  const preserved = new Set<string>();

  scanDoctorSessionTranscripts(
    {
      cfg: params.cfg,
      env,
      title: NOTE_TITLE,
      failureLabel: "Failed to inspect or rewrite labels",
      // Frozen migration identity plus loaded build/codec and the exact target/profile.
      cleanScanIdentity: (target) => [
        "session-transcript-labels:v1",
        VERSION,
        resolveRuntimeServiceBuildId(),
        resolveRuntimeServiceCommit(),
        process.versions.node,
        INBOUND_CONTEXT_MARKER,
        env.OPENCLAW_PROFILE ?? null,
        target.agentId,
        target.storePath,
        params.shouldRepair,
        params.integrityCheck ?? "quick",
      ],
    },
    ({ reader, target, databaseOptions, reportError, sessionId }) => {
      const { agentId } = target;
      const readResult = reader.labelRepairSnapshot(
        sessionId,
        normalizeLegacyInboundContextLabels,
        mayContainLegacyInboundContextLabels,
      );
      if (!readResult.ok) {
        reportError(
          `- Failed to read transcript for session ${sessionId} (${agentId})`,
          readResult.error,
        );
        return false;
      }

      const updates: Array<{ seq: number; eventJson: string }> = [];
      let hasMalformedRow = false;
      for (const row of readResult.rows) {
        let event: unknown;
        try {
          event = JSON.parse(row.eventJson);
        } catch {
          // A malformed sibling cannot produce a valid deferred projection after repair.
          hasMalformedRow = true;
          continue;
        }
        if (normalizeLegacyInboundContextLabels(event)) {
          updates.push({ seq: row.seq, eventJson: JSON.stringify(event) });
        }
      }

      if (updates.length === 0) {
        return true;
      }

      foundSessions += 1;
      foundEvents += updates.length;

      if (params.shouldRepair) {
        try {
          if (hasMalformedRow) {
            throw new Error(`transcript contains malformed event JSON for ${sessionId}`);
          }
          runOpenClawAgentWriteTransaction(
            (writeDatabase) => {
              const currentRows = readTranscriptEventRows(writeDatabase, sessionId);
              if (!transcriptSnapshotsMatch(readResult.rows, currentRows)) {
                throw new Error(`transcript changed while preparing rewrite for ${sessionId}`);
              }
              if (!preserved.has(target.sqlitePath)) {
                const backup = backupDoctorSqliteRepair(target.sqlitePath, "transcript-labels");
                preserved.add(target.sqlitePath);
                note(`- Saved pre-repair SQLite backup: ${backup}`, NOTE_TITLE);
              }
              // Surgical per-row update: preserves seq, created_at, and sessions row.
              updateSqliteTranscriptEventJsonInTransaction(writeDatabase, sessionId, updates);
            },
            databaseOptions,
            {
              operationLabel: "doctor.session-transcript-labels",
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
                ],
              },
            },
          );
          repairedSessions += 1;
          repairedEvents += updates.length;
        } catch (repairError) {
          reportError(
            `- Failed to rewrite labels for session ${sessionId} (${agentId})`,
            repairError,
          );
        }
      }
      // Findings and repairs are not a clean scan, even when the repair succeeded.
      return false;
    },
  );

  if (params.shouldRepair && repairedSessions > 0) {
    note(
      `- Rewrote legacy inbound-context labels in ${countLabel(repairedSessions, "session")} (${countLabel(repairedEvents, "event")}).`,
      NOTE_TITLE,
    );
  } else if (!params.shouldRepair && foundEvents > 0) {
    note(
      [
        `- Found ${countLabel(foundSessions, "session")} with legacy inbound-context labels.`,
        '- Run "openclaw doctor --fix" to rewrite them.',
      ].join("\n"),
      NOTE_TITLE,
    );
  }
}
