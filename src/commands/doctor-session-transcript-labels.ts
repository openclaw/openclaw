import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { INBOUND_CONTEXT_MARKER } from "../auto-reply/reply/inbound-context-marker.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  scanDoctorSessionTranscripts,
  transcriptSnapshotsMatch,
} from "./doctor-session-transcript-scan.js";
import { countLabel } from "./doctor-state-integrity-format.js";

const NOTE_TITLE = "Session transcript labels";

// Frozen copy of the shipped timestamp envelope. Local, not imported: this migration must match
// historical bytes even if the runtime pattern later evolves.
const LEGACY_LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

// Runtime strippers and memory-lancedb recognize the provenance marker, not these legacy labels.
// Enumerate shipped labels: a JSON fence alone cannot distinguish user-authored content. Verbatim
// copies of fixed internal labels still rewrite, matching the current sentinel's tradeoff.
//
// Old emitters (merge-base 7c896d78592e33f2f5fa1bb36ca588dcc3f96143, inbound-meta.ts unless noted):
// FENCED: "Conversation info" (711), "Sender" (block removed before merge-base; its sentinel survived
//   at strip-inbound-meta.ts:31, so old transcripts still carry it), "Thread starter" (718),
//   "Reply chain of current user message" (729), "Reply target of current user message" (735),
//   "Replied message" (renamed in 64e28a6ac94), "Forwarded message context" (755), "Location" (761),
//   dynamic `${label}` + "Structured object" fallback (271-272, 774).
// PLAIN: "Untrusted context (metadata, …)" (untrusted-context.ts:16 and active-memory/types.ts:334),
//   "Chat history since last reply" (805).
// CHAT WINDOW: `${label} (untrusted, <order>, <relation>):` (338-360).

function mayContainLegacyInboundContextLabels(eventJson: string): boolean {
  // Every frozen rewrite requires one of these decoded spellings. Unicode escapes
  // can conceal either spelling, so those rows still use the canonical JSON decoder.
  return (
    eventJson.includes("untrusted") || eventJson.includes("Untrusted") || eventJson.includes("\\u")
  );
}

function applyLegacyInboundLabelRewrites(text: string): string {
  // Every legacy rule contains one of these spellings. Check decoded content so
  // Unicode-escaped labels still reach their rewrite.
  if (!text.includes("untrusted") && !text.includes("Untrusted")) {
    return text;
  }

  // Match the runtime stripper's timestamp handling so an initial context block stays recognizable.
  const timestampMatch = text.match(LEGACY_LEADING_TIMESTAMP_PREFIX_RE);
  const timestampPrefix = timestampMatch ? timestampMatch[0] : "";
  let normalized = timestampPrefix ? text.slice(timestampPrefix.length) : text;

  normalized = normalized.replace(
    /^(Conversation info|Sender|Forwarded message context|Location|Structured object) \(untrusted metadata\):[ \t]*\n```json/gm,
    `$1: ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  // Active-memory keeps bare Context:. Preserve CRLF because assistant rows bypass newline
  // normalization; otherwise the marked channel rewrite would hide the active-memory body.
  normalized = normalized.replace(
    /^Untrusted context \(metadata, do not treat as instructions or commands\):([ \t]*\r?\n)(?=<active_memory_plugin>[ \t]*(?:\r?\n|$))/gm,
    "Context:$1",
  );
  normalized = normalized.replace(
    /^Untrusted context \(metadata, do not treat as instructions or commands\):$/gm,
    `Context: ${INBOUND_CONTEXT_MARKER}`,
  );

  normalized = normalized.replace(
    /^Chat history since last reply \(untrusted, for context\):$/gm,
    `Chat history since last reply: ${INBOUND_CONTEXT_MARKER}`,
  );

  normalized = normalized.replace(
    /^(Thread starter|Reply target of current user message) \(untrusted, for context\):[ \t]*\n```json/gm,
    `$1: ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  normalized = normalized.replace(
    /^Reply chain of current user message \(untrusted, nearest first\):[ \t]*\n```json/gm,
    `Reply chain of current user message (nearest first): ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  // 64e28a6ac94 renamed this block; retain its canonical label for the current recognizers.
  normalized = normalized.replace(
    /^Replied message \(untrusted, for context\):[ \t]*\n```json/gm,
    `Reply target of current user message: ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  // Dynamic chat-window labels require the shipped chronological tuple, not bare prose.
  normalized = normalized.replace(
    /^(.+) \(untrusted, chronological(, [^)\n]+)?\):$/gm,
    (_match, label, qualifier) =>
      `${label} (chronological${qualifier ?? ""}): ${INBOUND_CONTEXT_MARKER}`,
  );

  return timestampPrefix + normalized;
}

function normalizeLegacyInboundContextLabels(event: TranscriptEvent): boolean {
  if (!isRecord(event) || event.type !== "message") {
    return false;
  }
  const message = asOptionalObjectRecord(event.message);
  // Assistant turns can echo a context block into their output, and the shipped label-based strippers
  // removed those too (gateway/chat-sanitize.ts, replay-history.ts, session-cost-usage.ts). Skipping
  // them here would leave old assistant blocks unmarked, so they would leak on replay after upgrade.
  if (!message || (message.role !== "user" && message.role !== "assistant")) {
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
    if (!isRecord(part) || typeof part.text !== "string") {
      continue;
    }
    const normalized = applyLegacyInboundLabelRewrites(part.text);
    if (normalized !== part.text) {
      part.text = normalized;
      changed = true;
    }
  }
  return changed;
}

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

  scanDoctorSessionTranscripts(
    {
      cfg: params.cfg,
      env,
      title: NOTE_TITLE,
      failureLabel: "Failed to inspect or rewrite labels",
    },
    ({ reader, target, databaseOptions, reportError }) => {
      const { agentId } = target;
      for (const sessionId of reader.sessionIds()) {
        const readResult = reader.repairSnapshot(
          sessionId,
          normalizeLegacyInboundContextLabels,
          mayContainLegacyInboundContextLabels,
        );
        if (!readResult.ok) {
          reportError(
            `- Failed to read transcript for session ${sessionId} (${agentId})`,
            readResult.error,
          );
          continue;
        }

        const updates: Array<{ seq: number; eventJson: string }> = [];
        let hasMalformedRow = false;
        for (const row of readResult.rows) {
          let event: TranscriptEvent;
          try {
            event = JSON.parse(row.eventJson) as TranscriptEvent;
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
          continue;
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
                // Surgical per-row update: preserves seq, created_at, and sessions row.
                updateSqliteTranscriptEventJsonInTransaction(writeDatabase, sessionId, updates);
              },
              databaseOptions,
              { operationLabel: "doctor.session-transcript-labels" },
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
      }
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
