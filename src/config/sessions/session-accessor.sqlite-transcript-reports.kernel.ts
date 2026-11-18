import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeUsage } from "../../agents/usage.js";
import type { AssistantMessage } from "../../llm/types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
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
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { projectSessionUsageSnapshot } from "./session-entry-usage.js";
import {
  hasSettledTranscriptAssistant,
  selectTranscriptReport,
} from "./session-transcript-report-policy.js";
import {
  readTranscriptReportNavigation,
  readTranscriptReportEvent,
} from "./session-transcript-report-read.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

export function prepareTranscriptReportSelection(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  selection: TranscriptReportSelection,
): PreparedTranscriptReport {
  return selectTranscriptReport(
    readTranscriptReportNavigation(database, resolved.sessionId).facts(),
    (seq) => readTranscriptReportEvent(database, resolved.sessionId, seq),
    selection,
  );
}

/** The producer has settled; only its committed answer may replace the buffered fallback. */
export function appendAbortedSessionTranscriptPartialInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  partial: AbortedSessionTranscriptPartial,
  preparedMessage: PreparedTranscriptMessageAppend<Record<string, unknown>>,
  projection?: { scheduleProjectionReconcile: false; onProjectionReconcileNeeded: () => void },
  onEntryUpdated?: (entry: InternalSessionEntry) => void,
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
  const branch = readTranscriptReportNavigation(database, resolved.sessionId).facts();
  if (
    hasSettledTranscriptAssistant(
      branch,
      (seq) => readTranscriptReportEvent(database, resolved.sessionId, seq),
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
    const updatedEntry = writeSessionEntry(
      database,
      resolved.sessionKey,
      {
        ...current,
        // The fallback and its unavailable usage are one committed observation.
        ...projectSessionUsageSnapshot(
          normalizeUsage(asOptionalRecord(preparedMessage.persistedMessage.usage)),
          undefined,
        ),
        updatedAt: Math.max(current.updatedAt ?? 0, Date.now()),
      },
      { canonicalPreviousEntry: current },
    );
    onEntryUpdated?.(updatedEntry);
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
