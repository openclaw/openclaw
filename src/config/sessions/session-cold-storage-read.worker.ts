import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  createVisibleAssistantResultEventMatcher,
  matchesTranscriptEvent,
} from "../../sessions/transcript-visible-record.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import type { SessionColdArchive } from "./session-accessor.sqlite-archive-types.js";
import type {
  TranscriptEvent,
  LatestTranscriptAssistantText,
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import {
  hasSessionTranscriptMessageInDatabase,
  readLatestAssistantTextFromDatabase,
  readLatestAssistantMessageEvent,
} from "./session-accessor.sqlite-transcript-metadata-read.js";
import { readVerifiedSessionColdChunks } from "./session-cold-storage-chunks.js";
import { decodeSessionColdRecords } from "./session-cold-storage-codec.js";
import { readSessionColdStorageInventory } from "./session-cold-storage-inventory.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type { SessionTranscriptMatchDiagnostics } from "./session-history-read.types.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";
import { findTranscriptEventMatchingInDatabase } from "./session-transcript-match-read.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type { SessionTranscriptEventMatchRequest } from "./session-transcript-worker-read.types.js";
import { projectAssistantTranscriptText } from "./transcript-assistant-delivery-read.js";

export function readSessionColdStorageInventoryInWorker(options: OpenClawAgentDatabaseOptions) {
  const counts = withOpenClawAgentDatabaseReadOnly(readSessionColdStorageInventory, options);
  return counts.found ? counts.value : readSessionColdStorageInventory();
}

export function readSessionColdMetadataInWorker(
  options: OpenClawAgentDatabaseOptions,
  sessionId: string,
) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionColdTranscript(database.db, sessionId),
    options,
  );
  return result.found ? result.value : undefined;
}

/** Newest-first matching retains only one bounded archive chunk and verifies every chunk. */
function findSessionColdTranscriptEvent(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  archive: Omit<SessionColdArchive, "archive_blob">,
  match: (event: TranscriptEvent) => boolean,
  selection?: {
    active?: boolean;
    indexedMessage?: boolean;
    beforeSeq?: number;
    diagnostics?: SessionTranscriptMatchDiagnostics;
  },
): { event: TranscriptEvent } | undefined {
  let found: { event: TranscriptEvent } | undefined;
  let indexReady = !selection?.active;
  let unclassified = false;
  for (const chunk of readVerifiedSessionColdChunks(database.db, database.path, archive, true)) {
    const events: Array<{ seq: number; event_json: string }> = [];
    const identities = new Map<string, number>();
    const messages = new Set<number>();
    const active = new Set<number>();
    for (const record of decodeSessionColdRecords(chunk.bytes, chunk.archive)) {
      if (record.kind === "event" && selection?.diagnostics) {
        selection.diagnostics.rowsVisited++;
        selection.diagnostics.coldRows++;
      }
      if (record.kind === "index") {
        indexReady = !record.row.needs_rebuild && record.row.indexed_seq === archive.last_seq;
      } else if (record.kind === "active" && record.row.context_eligible === null) {
        unclassified = true;
      }
      if (found) {
        continue;
      }
      if (record.kind === "event") {
        if (selection?.beforeSeq === undefined || record.row.seq < selection.beforeSeq) {
          events.push(record.row);
        }
      } else if (record.kind === "identity") {
        if (selection?.active) {
          identities.set(record.row.event_id, record.row.seq);
        }
        if (selection?.indexedMessage && record.row.event_type === "message") {
          messages.add(record.row.seq);
        }
      } else if (record.kind === "active" && record.row.message_position !== null) {
        if (selection?.active) {
          active.add(record.row.event_seq);
        }
      }
    }
    for (let index = events.length - 1; index >= 0 && !found; index--) {
      const row = events[index]!;
      if (selection?.indexedMessage && !messages.has(row.seq)) {
        continue;
      }
      try {
        const event: unknown = JSON.parse(row.event_json);
        if (
          selection?.active &&
          (!active.has(row.seq) ||
            !event ||
            typeof event !== "object" ||
            !("id" in event) ||
            typeof event.id !== "string" ||
            identities.get(event.id) !== row.seq)
        ) {
          continue;
        }
        if (match(event)) {
          found = { event };
        }
      } catch {
        // Match reads retain the hot reader's tolerance for malformed imported event JSON.
      }
    }
  }
  if (selection?.active && (!indexReady || unclassified)) {
    // Stale projections still need the existing restoration/reconciliation owner.
    throw new SessionTranscriptColdError(archive.session_id);
  }
  return found;
}

/** Identity classifications remain authoritative for exact imports, just as for hot rows. */
function hasSessionColdTranscriptMessage(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  archive: Omit<SessionColdArchive, "archive_blob">,
): boolean {
  let present = false;
  for (const chunk of readVerifiedSessionColdChunks(database.db, database.path, archive)) {
    const unclassifiedMessages = new Set<number>();
    for (const record of decodeSessionColdRecords(chunk.bytes, chunk.archive)) {
      if (present) {
        continue;
      }
      if (record.kind === "event") {
        try {
          const event: unknown = JSON.parse(record.row.event_json);
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "message"
          ) {
            unclassifiedMessages.add(record.row.seq);
          }
        } catch {
          /* Hot presence probes skip malformed imported payloads. */
        }
      } else if (record.kind === "identity" && record.row.event_type !== null) {
        unclassifiedMessages.delete(record.row.seq);
        present = record.row.event_type === "message";
      }
    }
    present ||= unclassifiedMessages.size > 0;
  }
  return present;
}

/** Keep cold detection and archive bytes in the same snapshot without changing hot queries. */
function readColdAware<T>(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  hot: () => T,
  cold: (archive: Omit<SessionColdArchive, "archive_blob">) => T,
): T {
  return runSqliteReadSnapshotSync(database.db, () => {
    try {
      return hot();
    } catch (error) {
      if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== sessionId) {
        throw error;
      }
      const archive = readSessionColdTranscript(database.db, sessionId);
      if (!archive) {
        throw error;
      }
      return cold(archive);
    }
  });
}

export function readSessionTranscriptMessagePresenceInWorker(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
): boolean {
  return readColdAware(
    database,
    sessionId,
    () => hasSessionTranscriptMessageInDatabase(database, sessionId),
    (archive) => hasSessionColdTranscriptMessage(database, archive),
  );
}

export function readLatestSessionTranscriptAssistantInWorker(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  scope: Pick<ResolvedTranscriptReadScope, "agentId" | "sessionId" | "sessionKey">,
): LatestTranscriptAssistantText | undefined {
  return readColdAware(
    database,
    scope.sessionId,
    () => readLatestAssistantTextFromDatabase(database, scope),
    (archive) => {
      let text: LatestTranscriptAssistantText | undefined;
      findSessionColdTranscriptEvent(
        database,
        archive,
        (event) => {
          const latest = readLatestAssistantMessageEvent(event);
          text = latest && projectAssistantTranscriptText(latest.message, latest.id);
          return Boolean(text);
        },
        {
          indexedMessage: true,
          beforeSeq: resolveSqliteSessionTranscriptReadFence({ database, ...scope })?.beforeRawSeq,
        },
      );
      return text;
    },
  );
}

export function findSessionTranscriptEventInWorker(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  request: SessionTranscriptEventMatchRequest,
): { event: TranscriptEvent } | undefined {
  const { target, match } = request;
  const complete = (result: { event: TranscriptEvent } | undefined) => {
    if (request.diagnostics) {
      request.diagnostics.outcome = result ? "hit" : "miss";
    }
    return result;
  };
  return readColdAware(
    database,
    target.sessionId,
    () => complete(findTranscriptEventMatchingInDatabase(database, request)),
    (archive) => {
      const active = match.kind === "active-assistant" || match.kind === "canvas-widget";
      const matchesVisibleFinal =
        match.kind === "visible-final"
          ? createVisibleAssistantResultEventMatcher(match.runId)
          : undefined;
      return complete(
        findSessionColdTranscriptEvent(
          database,
          archive,
          (event) =>
            (!active || Boolean(target.sessionKey)) &&
            (matchesVisibleFinal
              ? matchesVisibleFinal(event)
              : matchesTranscriptEvent(event, match)),
          { active, diagnostics: request.diagnostics },
        ),
      );
    },
  );
}
