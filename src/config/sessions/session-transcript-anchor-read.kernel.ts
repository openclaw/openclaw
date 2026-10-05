import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptWriteScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { loadTranscriptEventRowsAfterSeqInDatabase } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptHeaderFromDatabase } from "./session-accessor.sqlite-transcript-metadata-read.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type SessionTranscriptAnchorSelection = {
  entryIds: readonly string[];
  afterSeq?: number;
  includeHeader?: boolean;
  contextValidation?: Parameters<typeof validateSessionTranscriptContextInDatabase>[2];
  replayValidation?: Pick<
    SessionTranscriptWriteScope,
    "expectedLifecycleRevision" | "expectedWriterRunId"
  > & { allowInitial: boolean };
};

export type SessionTranscriptAnchorFacts = {
  anchors: TranscriptEntryAnchor[];
  header?: unknown;
  contextValidated?: true;
  replayValidated?: "current" | "initial";
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
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ResolvedTranscriptScope,
  selection: SessionTranscriptAnchorSelection,
): SessionTranscriptAnchorFacts {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      let replayValidated: SessionTranscriptAnchorFacts["replayValidated"];
      const replay = selection.replayValidation;
      if (replay) {
        const entry = readSessionEntryRow(database, resolved.sessionKey)?.entry;
        if (
          !entry &&
          replay.allowInitial &&
          readTranscriptHeaderFromDatabase(database, resolved.sessionId) === undefined
        ) {
          replayValidated = "initial";
        } else if (
          !entry ||
          entry.sessionId !== resolved.sessionId ||
          (replay.expectedLifecycleRevision !== undefined &&
            entry.lifecycleRevision !== replay.expectedLifecycleRevision) ||
          (replay.expectedWriterRunId !== undefined &&
            entry.activeWriterRunId !== replay.expectedWriterRunId)
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        } else {
          replayValidated = "current";
        }
      }
      const context = selection.contextValidation;
      if (context) {
        validateSessionTranscriptContextInDatabase(database, resolved, context);
      }
      const validated = {
        ...(context ? { contextValidated: true as const } : {}),
        ...(replayValidated ? { replayValidated } : {}),
      };
      const header: Pick<SessionTranscriptAnchorFacts, "header"> = {};
      if (selection.includeHeader) {
        try {
          header.header = readTranscriptHeaderFromDatabase(database, resolved.sessionId);
        } catch {
          // Lifecycle header metadata is best effort; reader admission and owner checks still fail closed.
        }
      }
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
        return { anchors: selected, ...validated, ...header };
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
      return {
        anchors: selected,
        ...validated,
        ...header,
        tail: { lastSeq: rows.at(-1)?.seq, entries },
      };
    },
    { databaseLabel: database.path, operationLabel: "session transcript anchors read" },
  );
}
