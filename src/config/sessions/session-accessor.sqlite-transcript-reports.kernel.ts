import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { AssistantMessage } from "../../llm/types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";
import type {
  AbortedSessionTranscriptPartial,
  AbortedSessionTranscriptPartialResult,
  CustomMessageReportAppend,
  PreparedTranscriptReport,
  SelectedTranscriptReport,
  TranscriptReportSelection,
  TranscriptReport,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
} from "./session-entry-codec.js";
import {
  decodeSessionTranscriptReportFacts,
  projectSessionTranscriptReportFacts,
  type SessionTranscriptReportFacts,
} from "./session-transcript-report-facts.js";
import {
  TranscriptReportNavigation,
  hasSettledTranscriptAssistant,
  selectTranscriptReport,
} from "./session-transcript-report-policy.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

function readReportBranch(database: OpenClawAgentDatabase, sessionId: string) {
  const rows = iterateSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select((eb) => [
        "seq",
        "event_json",
        eb
          .fn<string | null>("json_extract", [eb.ref("navigation_json"), eb.val("$.report")])
          .as("report_json"),
      ])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  );
  function compressedFacts(reportJson: string | null): SessionTranscriptReportFacts {
    const facts =
      reportJson === null ? undefined : decodeSessionTranscriptReportFacts(JSON.parse(reportJson));
    if (!facts) {
      throw new Error("Invalid compressed transcript report facts");
    }
    return facts;
  }
  let hasRows = false;
  let header: ReturnType<typeof findSessionTranscriptHeader>;
  const navigation = new TranscriptReportNavigation(
    (function* () {
      for (const row of rows) {
        hasRows = true;
        if (row.event_json === null) {
          yield { seq: row.seq, facts: compressedFacts(row.report_json) };
          continue;
        }
        const event: unknown = JSON.parse(row.event_json);
        if (!header) {
          header = findSessionTranscriptHeader([event]);
          if (header) {
            assertCurrentSessionTranscriptHeader(header);
          }
        }
        yield { seq: row.seq, facts: projectSessionTranscriptReportFacts(event) };
      }
    })(),
  );
  if (hasRows) {
    assertCurrentSessionTranscriptHeader(header);
  }
  return navigation.facts();
}

function readReportEvent(database: OpenClawAgentDatabase, sessionId: string, seq: number) {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(transcriptEventJsonSql(database.db).as("event_json"))
      .where("session_id", "=", sessionId)
      .where("seq", "=", seq),
  );
  const event: unknown = row ? JSON.parse(row.event_json) : undefined;
  return asOptionalRecord(event);
}

export function prepareTranscriptReportSelection(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  selection: TranscriptReportSelection,
): PreparedTranscriptReport {
  return selectTranscriptReport(
    readReportBranch(database, resolved.sessionId),
    (seq) => readReportEvent(database, resolved.sessionId, seq),
    selection,
  );
}

/** Process-held reports select and append without crossing their native transaction boundary. */
export function appendSessionTranscriptReportInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  report: TranscriptReport,
): void {
  const facts = prepareTranscriptReportSelection(
    database,
    resolved,
    report.kind === "assistant"
      ? { kind: "assistant", responseId: report.message.responseId }
      : report,
  );
  if (facts.suppressed) {
    return;
  }
  if (report.kind === "assistant") {
    appendSelectedTranscriptReportInTransaction(database, resolved, facts.appendParentId, report);
    return;
  }
  const selected = report.selectReport(facts.latest);
  if (selected) {
    appendSelectedTranscriptReportInTransaction(
      database,
      resolved,
      facts.appendParentId,
      prepareCustomTranscriptReport(selected, facts.appendParentId),
    );
  }
}

/** The producer has settled; only its committed answer may replace the buffered fallback. */
export function appendAbortedSessionTranscriptPartialInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  partial: AbortedSessionTranscriptPartial,
  preparedMessage: PreparedTranscriptMessageAppend<Record<string, unknown>>,
  projection?: { scheduleProjectionReconcile: false; onProjectionReconcileNeeded: () => void },
): AbortedSessionTranscriptPartialResult {
  assertSessionTranscriptHot(database.db, resolved.sessionId);
  const entry = readSessionEntryRow(database, resolved.sessionKey)?.entry;
  if (
    !entry ||
    entry.sessionId !== resolved.sessionId ||
    (partial.expectedLifecycleRevision !== undefined &&
      entry.lifecycleRevision !== (partial.expectedLifecycleRevision ?? undefined))
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const branch = readReportBranch(database, resolved.sessionId);
  if (
    hasSettledTranscriptAssistant(
      branch,
      (seq) => readReportEvent(database, resolved.sessionId, seq),
      partial.runId,
    )
  ) {
    return { skipped: true };
  }
  // Deferred Gateway settlement has no model writer context; recheck durable custody here.
  if (entry.activeWriterRunId !== undefined && entry.activeWriterRunId !== partial.runId) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const committed = appendTranscriptMessageInTransaction(
    database,
    resolved,
    {
      message: preparedMessage.persistedMessage,
      parentId: branch.appendParentId,
      idempotencyLookup: "scan-assistant",
      now: partial.now,
      useRawWhenLinear: true,
    },
    preparedMessage,
    projection,
  );
  const append = committed?.result;
  if (!append) {
    throw new Error("Aborted assistant partial was not appended");
  }
  if (append.appended) {
    // Appending can update transcript-owned entry fields; retain the authoritative row.
    const current = readSessionEntryRow(database, resolved.sessionKey)?.entry;
    if (!current || current.sessionId !== resolved.sessionId) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    writeSessionEntry(
      database,
      resolved.sessionKey,
      { ...current, updatedAt: Math.max(current.updatedAt ?? 0, Date.now()) },
      { canonicalPreviousEntry: current },
    );
  }
  return {
    skipped: false,
    append,
    lifecycleRevision: entry.lifecycleRevision,
    ...(append.anchor ? { messageSeq: append.anchor.activeMessagePosition + 1 } : {}),
  };
}

/** Serialize the final envelope here so user-owned toJSON methods run once before transfer. */
export function prepareCustomTranscriptReport(
  selected: CustomMessageReportAppend,
  appendParentId: string | null,
): Extract<SelectedTranscriptReport, { kind: "custom" }> {
  const eventJson = JSON.stringify({
    type: "custom_message",
    ...selected,
    id: randomUUID(),
    parentId: appendParentId,
    timestamp: new Date().toISOString(),
  });
  if (eventJson === undefined) {
    throw new Error("Session transcript report serialization did not produce an event");
  }
  return { kind: "custom", eventJson };
}

export function appendSelectedTranscriptReportInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  appendParentId: string | null,
  report: SelectedTranscriptReport,
  projection?: { scheduleProjectionReconcile: false; onProjectionReconcileNeeded: () => void },
  preparedMessage?: PreparedTranscriptMessageAppend<AssistantMessage & { responseId: string }>,
): void {
  if (report.kind === "assistant") {
    appendTranscriptMessageInTransaction(
      database,
      resolved,
      {
        message:
          preparedMessage?.persistedMessage ?? applyAssistantDeliveryDirectives(report.message),
        parentId: appendParentId,
      },
      preparedMessage,
      projection,
    );
    return;
  }
  ensureTranscriptHeader(database, resolved, undefined, projection);
  const event: unknown = JSON.parse(report.eventJson);
  const appended = appendTranscriptEventInTransaction(database, resolved, event, {
    ...projection,
    eventJson: report.eventJson,
  });
  if (!appended) {
    throw new Error("Session transcript report was not appended");
  }
}
