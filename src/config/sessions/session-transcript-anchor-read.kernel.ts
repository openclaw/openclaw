import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { loadTranscriptEventRowsAfterSeqInDatabase } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type SessionTranscriptAnchorSelection = {
  entryIds: readonly string[];
  afterSeq?: number;
};

export type SessionTranscriptAnchorFacts = {
  anchors: TranscriptEntryAnchor[];
  tail?: {
    lastSeq?: number;
    entries: {
      entryId: string;
      role: "user" | "assistant";
      runId?: string;
      anchor?: TranscriptEntryAnchor;
    }[];
  };
};

/** Readiness, identities and optional reply-tail facts belong to one snapshot. */
export function readSessionTranscriptAnchorFactsInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ResolvedTranscriptScope,
  selection: SessionTranscriptAnchorSelection,
): SessionTranscriptAnchorFacts {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const anchors = new Map<string, TranscriptEntryAnchor | undefined>();
      const readAnchor = (entryId: string) => {
        if (!anchors.has(entryId)) {
          anchors.set(
            entryId,
            readActiveTranscriptEntryAnchorInTransaction({ database, resolved, entryId }),
          );
        }
        return anchors.get(entryId);
      };
      const selected = selection.entryIds.flatMap((entryId) => readAnchor(entryId) ?? []);
      if (selection.afterSeq === undefined) {
        return { anchors: selected };
      }
      const rows = loadTranscriptEventRowsAfterSeqInDatabase(
        database,
        resolved.sessionId,
        selection.afterSeq,
      );
      const entries: NonNullable<SessionTranscriptAnchorFacts["tail"]>["entries"] = [];
      for (const { event } of rows) {
        const row = asOptionalRecord(event);
        const message = asOptionalRecord(row?.message);
        if (
          typeof row?.id !== "string" ||
          (message?.role !== "user" && message?.role !== "assistant")
        ) {
          continue;
        }
        const anchor = message.role === "user" ? readAnchor(row.id) : anchors.get(row.id);
        const runId = readSessionTranscriptRunId(message);
        entries.push({
          entryId: row.id,
          role: message.role,
          ...(runId ? { runId } : {}),
          ...(anchor ? { anchor } : {}),
        });
      }
      return { anchors: selected, tail: { lastSeq: rows.at(-1)?.seq, entries } };
    },
    { databaseLabel: database.path, operationLabel: "session transcript anchors read" },
  );
}
