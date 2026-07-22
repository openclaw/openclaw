import fs from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import {
  readSqliteTranscriptSnapshot,
  type SqliteTranscriptSnapshotRow,
} from "../config/sessions/session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { listSqliteSessionTranscriptInstances } from "../config/sessions/session-accessor.sqlite.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";

const NOTE_TITLE = "Session transcript labels";

// Line-anchored legacy forms emitted before the plain-label rename. Doctor rewrites stored
// transcripts once; runtime strippers match only current labels. Accepted tradeoff: dynamic labels
// prevent an exact allowlist, so rare user prose ending a line with a legacy suffix is rewritten.
const LEGACY_INBOUND_LABEL_REWRITES: ReadonlyArray<
  [RegExp, string | ((match: string, label: string, qualifier?: string) => string)]
> = [
  [/^Untrusted context \(metadata, do not treat as instructions or commands\):$/gm, "Context:"],
  [/^(.+) \(untrusted metadata\):$/gm, "$1:"],
  [/^(.+) \(untrusted, for context\):$/gm, "$1:"],
  [/^(.+) \(untrusted, nearest first\):$/gm, "$1 (nearest first):"],
  [
    /^(.+) \(untrusted, chronological(, [^)\n]+)?\):$/gm,
    (_match, label, qualifier) => `${label} (chronological${qualifier ?? ""}):`,
  ],
];

type SessionLabelRewritePlan = {
  changedEvents: number;
  events: TranscriptEvent[];
  scope: ResolvedTranscriptScope;
  snapshotRows: SqliteTranscriptSnapshotRow[];
};

function applyLegacyInboundLabelRewrites(text: string): string {
  let normalized = text;
  for (const [pattern, replacement] of LEGACY_INBOUND_LABEL_REWRITES) {
    normalized =
      typeof replacement === "string"
        ? normalized.replace(pattern, replacement)
        : normalized.replace(pattern, (match, label, qualifier) =>
            replacement(match, label, qualifier),
          );
  }
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
      const database = openOpenClawAgentDatabase(databaseOptions);
      const plans: SessionLabelRewritePlan[] = [];
      for (const instance of listSqliteSessionTranscriptInstances({
        agentId,
        env,
        storePath: target.storePath,
      })) {
        const snapshot = readSqliteTranscriptSnapshot(database, instance.sessionId);
        const changedEvents = snapshot.events.reduce(
          (count: number, event) => count + (normalizeLegacyInboundContextLabels(event) ? 1 : 0),
          0,
        );
        if (changedEvents === 0) {
          continue;
        }
        plans.push({
          changedEvents,
          events: snapshot.events,
          scope: {
            agentId,
            env,
            path: sqlitePath,
            sessionId: instance.sessionId,
            sessionKey: instance.sessionKey,
          },
          snapshotRows: snapshot.rows,
        });
      }

      foundSessions += plans.length;
      foundEvents += plans.reduce((count, plan) => count + plan.changedEvents, 0);
      if (!params.shouldRepair || plans.length === 0) {
        continue;
      }

      for (const plan of plans) {
        runOpenClawAgentWriteTransaction(
          (writeDatabase) => {
            const current = readSqliteTranscriptSnapshot(writeDatabase, plan.scope.sessionId);
            if (!snapshotsMatch(plan.snapshotRows, current.rows)) {
              throw new Error(
                `transcript changed while preparing rewrite for ${plan.scope.sessionId}`,
              );
            }
            replaceSqliteTranscriptEventsInTransaction(writeDatabase, plan.scope, plan.events);
          },
          databaseOptions,
          { operationLabel: "doctor.session-transcript-labels" },
        );
        repairedSessions += 1;
        repairedEvents += plan.changedEvents;
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
