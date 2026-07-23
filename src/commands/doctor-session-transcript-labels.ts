import fs from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import {
  readSqliteTranscriptEventRows,
  type SqliteTranscriptSnapshotRow,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  readOnlySqliteTranscriptSessionIds,
  readOnlySqliteTranscriptSnapshot,
  resolveTargetSqlitePath,
} from "./doctor-session-sqlite-readers.js";

const NOTE_TITLE = "Session transcript labels";

// Rewrites legacy inbound-context block labels. Doctor applies these rewrites once; runtime
// strippers match only current labels.
//
// STRUCTURAL RECOGNITION (prevents data corruption):
// - FENCED blocks: gate by checking next line is ```json fence (line immediately following).
//   This is safe for arbitrary/dynamic labels since the fence disambiguates them.
// - PLAIN-TEXT blocks: exact-match only. No catch-all patterns.
// - CHAT WINDOW pattern: kept as-is (dynamic label but distinctive pattern).
//
// ACCEPTED TRADEOFF (all rules): in the extreme tail, a user message whose body contains a line
// that verbatim-matches an OpenClaw-internal legacy label gets rewritten to the current form.
// - Fenced rules (1, 4-7) additionally require a following ```json fence, so they are self-limiting.
//   Effect there is a minor label edit; the block stays visible.
// - Unfenced rules (2, 3, 8) match a standalone line with no fence. Rules 3 and 8 rewrite to a
//   current sentinel that the runtime stripper then removes (line + following window) on replay
//   (strip-inbound-meta.ts). This is intentional and consistent with existing runtime behavior:
//   the runtime ALREADY strips a user line that verbatim-matches a current sentinel; the migration
//   only extends that to the old-label form in historical transcripts. Rule 2 rewrites to `Context:`,
//   which the runtime strips only when followed by an <active_memory_plugin> tag, so a bare match is
//   a cosmetic label edit.
// Accepted because: the trigger requires authoring an exact internal label string as a standalone
// line; these unfenced rules are REQUIRED to close the memory-lancedb re-capture leak (its capture
// recognizers key on the same current labels: extensions/memory-lancedb/index.ts INBOUND_META_SENTINELS
// + LEADING_CHRONOLOGICAL_CONTEXT_LABEL_RE); and enumerate-only matching would leave dynamic-label
// blocks unmigrated.
//
// Trace of old emitters from src/auto-reply/reply/inbound-meta.ts (merge-base 7c896d78592e33f2f5fa1bb36ca588dcc3f96143):
// FENCED: "Conversation info (untrusted metadata):" (711), "Thread starter (untrusted, for context):" (718),
//   "Reply chain of current user message (untrusted, nearest first):" (729),
//   "Reply target of current user message (untrusted, for context):" (735),
//   "Replied message (untrusted, for context):" (fenced, shipped ≤v2026.5.2, renamed in 64e28a6ac94),
//   "Forwarded message context (untrusted metadata):" (755), "Location (untrusted metadata):" (761),
//   dynamic `${label} (untrusted metadata):` (271-272, 774).
// PLAIN-TEXT: "Untrusted context (metadata, do not treat as instructions or commands):" (untrusted-context.ts:16),
//   "Chat history since last reply (untrusted, for context):" (805).
// CHAT WINDOW: `${label} (${["untrusted", order, relation].filter(Boolean).join(", ")}):` (338-360).

function applyLegacyInboundLabelRewrites(text: string): string {
  let normalized = text;

  // 1. FENCE-GATED: <arbitrary-label> (untrusted metadata): only when next line is ```json.
  // This covers both static fenced blocks and dynamic structured labels.
  normalized = normalized.replace(
    /^([^\n]+) \(untrusted metadata\):[ \t]*\n```json/gm,
    "$1:\n```json",
  );

  // 2. EXACT-MATCH plain-text blocks: the long "do not treat as instructions" header.
  normalized = normalized.replace(
    /^Untrusted context \(metadata, do not treat as instructions or commands\):$/gm,
    "Context:",
  );

  // 3. EXACT-MATCH plain-text: "Chat history since last reply" footer.
  normalized = normalized.replace(
    /^Chat history since last reply \(untrusted, for context\):$/gm,
    "Chat history since last reply:",
  );

  // 4. FENCE-GATED fenced: "Thread starter" block (only rewrite if followed by ```json fence).
  normalized = normalized.replace(
    /^Thread starter \(untrusted, for context\):[ \t]*\n```json/gm,
    "Thread starter:\n```json",
  );

  // 5. FENCE-GATED fenced: "Reply target of current user message" block (only rewrite if followed by ```json fence).
  normalized = normalized.replace(
    /^Reply target of current user message \(untrusted, for context\):[ \t]*\n```json/gm,
    "Reply target of current user message:\n```json",
  );

  // 6. FENCE-GATED fenced: "Reply chain of current user message" block (only rewrite if followed by ```json fence).
  normalized = normalized.replace(
    /^Reply chain of current user message \(untrusted, nearest first\):[ \t]*\n```json/gm,
    "Reply chain of current user message (nearest first):\n```json",
  );

  // 7. FENCE-GATED fenced: "Replied message" block (shipped ≤v2026.5.2, fenced, recognized as current sentinel).
  normalized = normalized.replace(
    /^Replied message \(untrusted, for context\):[ \t]*\n```json/gm,
    "Replied message:\n```json",
  );

  // 8. PATTERN-BASED chat windows (dynamic labels, non-fenced): distinctive (untrusted, chronological, ...)
  // pattern. Mirrors runtime detection in extensions/memory-lancedb/index.ts LEADING_CHRONOLOGICAL_CONTEXT_LABEL_RE.
  // This is the only residual pattern-based rewrite but it is narrow (matches the highly distinctive
  // "untrusted, chronological" tuple, not bare prose ending with a suffix).
  normalized = normalized.replace(
    /^(.+) \(untrusted, chronological(, [^)\n]+)?\):$/gm,
    (_match, label, qualifier) => `${label} (chronological${qualifier ?? ""}):`,
  );

  return normalized;
}

function normalizeLegacyInboundContextLabels(event: TranscriptEvent): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const entry = event as { message?: unknown; type?: unknown };
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
    return false;
  }
  const message = entry.message as { content?: unknown; role?: unknown };
  if (message.role !== "user") {
    return false;
  }
  if (typeof message.content === "string") {
    const normalized = applyLegacyInboundLabelRewrites(message.content);
    if (normalized === message.content) {
      return false;
    }
    message.content = normalized;
    return true;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  let changed = false;
  for (const part of message.content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      continue;
    }
    const textPart = part as { text?: unknown };
    if (typeof textPart.text !== "string") {
      continue;
    }
    const normalized = applyLegacyInboundLabelRewrites(textPart.text);
    if (normalized !== textPart.text) {
      textPart.text = normalized;
      changed = true;
    }
  }
  return changed;
}

function snapshotsMatch(
  expected: readonly SqliteTranscriptSnapshotRow[],
  current: readonly SqliteTranscriptSnapshotRow[],
): boolean {
  return (
    expected.length === current.length &&
    expected.every(
      (row, index) =>
        row.seq === current[index]?.seq && row.eventJson === current[index]?.eventJson,
    )
  );
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Reports or repairs legacy inbound-context labels in canonical SQLite transcripts. */
export async function noteSessionTranscriptLabelHealth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<void> {
  const env = params.env ?? process.env;
  let foundSessions = 0;
  let foundEvents = 0;
  let repairedSessions = 0;
  let repairedEvents = 0;

  const targetsBySqlitePath = new Map<string, { agentId: string; storePath: string }>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (!targetsBySqlitePath.has(sqlitePath)) {
      targetsBySqlitePath.set(sqlitePath, target);
    }
  }

  for (const [sqlitePath, target] of targetsBySqlitePath) {
    if (!fs.existsSync(sqlitePath)) {
      continue;
    }

    const { agentId } = target;
    const databaseOptions = { agentId, env, path: sqlitePath };

    try {
      // DETECTION + STREAMING REPAIR:
      // - Detection phase uses read-only database (no writable lifecycle).
      // - Each matching session is processed immediately in its own transaction.
      // - No buffering of all plans; one at a time, then discard.
      // - Per-row updates: only eventJson is modified, seq/created_at/session_key preserved.
      // - Enumerate from transcript_events (schema-stable) not sessions (post-ship column).

      const sessionIds = readOnlySqliteTranscriptSessionIds(sqlitePath);
      for (const sessionId of sessionIds) {
        // Read transcript in read-only mode (detection phase).
        const readResult = readOnlySqliteTranscriptSnapshot(sqlitePath, sessionId);
        if (!readResult.ok) {
          const detail = formatErrorMessage(readResult.error).replace(/\s+/g, " ").trim();
          note(
            `- Failed to read transcript for session ${sessionId} (${agentId}): ${detail}`,
            NOTE_TITLE,
          );
          continue;
        }

        // Build per-row change list keyed by seq. Parse each row individually so unparseable
        // rows (with corrupted eventJson) don't break the whole session.
        const updates: Array<{ seq: number; eventJson: string }> = [];
        for (const row of readResult.rows) {
          let event: TranscriptEvent;
          try {
            event = JSON.parse(row.eventJson) as TranscriptEvent;
          } catch {
            // Skip rows with unparseable eventJson (corrupted data).
            continue;
          }
          if (normalizeLegacyInboundContextLabels(event)) {
            updates.push({ seq: row.seq, eventJson: JSON.stringify(event) });
          }
        }

        if (updates.length === 0) {
          continue;
        }

        foundSessions += 1;
        foundEvents += updates.length;

        // REPAIR PHASE (if --fix): process immediately, don't buffer.
        if (params.shouldRepair) {
          try {
            runOpenClawAgentWriteTransaction(
              (writeDatabase) => {
                // Use rows-only guard (tolerant of malformed JSON in sibling rows).
                const currentRows = readSqliteTranscriptEventRows(writeDatabase, sessionId);
                if (!snapshotsMatch(readResult.rows, currentRows)) {
                  throw new Error(`transcript changed while preparing rewrite for ${sessionId}`);
                }
                // Surgical per-row update: preserves seq, created_at, and sessions row.
                updateSqliteTranscriptEventJsonInTransaction(writeDatabase, sessionId, updates);
              },
              databaseOptions,
              { operationLabel: "doctor.session-transcript-labels" },
            );
            repairedSessions += 1;
            repairedEvents += updates.length;
          } catch (repairError) {
            const detail = formatErrorMessage(repairError).replace(/\s+/g, " ").trim();
            note(
              `- Failed to rewrite labels for session ${sessionId} (${agentId}): ${detail}`,
              NOTE_TITLE,
            );
          }
        }
      }
    } catch (error) {
      const detail = formatErrorMessage(error).replace(/\s+/g, " ").trim();
      note(
        `- Failed to inspect or rewrite labels for ${agentId} (${sqlitePath}): ${detail}`,
        NOTE_TITLE,
      );
    }
  }

  if (params.shouldRepair && repairedSessions > 0) {
    note(
      `- Rewrote legacy inbound-context labels in ${formatCount(repairedSessions, "session")} (${formatCount(repairedEvents, "event")}).`,
      NOTE_TITLE,
    );
  } else if (!params.shouldRepair && foundEvents > 0) {
    note(
      [
        `- Found ${formatCount(foundSessions, "session")} with legacy inbound-context labels.`,
        '- Run "openclaw doctor --fix" to rewrite them.',
      ].join("\n"),
      NOTE_TITLE,
    );
  }
}
