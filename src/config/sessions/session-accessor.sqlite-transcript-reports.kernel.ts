import { randomUUID } from "node:crypto";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasSubagentSessionOwnerInDatabase } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { readGatewayOwnerLeaseFromDatabase } from "../../infra/gateway-owner-lease.read.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { AssistantMessage } from "../../llm/types.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { projectAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import {
  isOpenClawMessageToolMirrorAssistantMessage,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../../shared/transcript-only-openclaw-assistant.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withCachedOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly-reuse.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";
import {
  isStartupSessionSettlementCandidate,
  type AbortedSessionTranscriptPartial,
  type AbortedSessionTranscriptPartialResult,
  type CustomMessageReport,
  type CustomMessageReportAppend,
  type PreparedTranscriptReport,
  type SelectedTranscriptReport,
  type TranscriptReportSelection,
  type TranscriptReport,
  type StartupSessionSettlement,
  type StartupSessionSettlementOutcome,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
} from "./session-entry-codec.js";
import { SessionEntryNavigation, type SessionNavigationEntry } from "./session-entry-navigation.js";
import {
  decodeSessionTranscriptReportFacts,
  projectSessionTranscriptReportFacts,
  type SessionTranscriptReportFacts,
} from "./session-transcript-report-facts.js";
import { settleArchivedSessionRun } from "./terminal-status.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

type ReportNavigationEntry = SessionNavigationEntry & {
  seq: number;
  customType?: string;
  assistantResponseId?: string;
  assistantRunId?: string;
};

class TranscriptReportNavigation extends SessionEntryNavigation<ReportNavigationEntry> {
  constructor(rows: Iterable<{ seq: number; facts: SessionTranscriptReportFacts }>) {
    super();
    for (const { seq, facts } of rows) {
      switch (facts.kind) {
        case "canonical":
          this.appendCanonicalNavigationEntry(
            { ...facts.entry, parentId: facts.entry.parentId ?? null, seq },
            facts.hasParentId,
          );
          break;
        case "leaf":
          this.appendOpaqueNavigationRecord({ ...facts.entry, type: "leaf" });
          break;
        case "link":
          this.appendOpaqueNavigationRecord(facts);
          break;
        case "ignored":
          break;
      }
    }
    this.finishNavigation();
  }

  facts() {
    return { appendParentId: this.appendParentId, path: this.getBranch() };
  }
}

function readReportBranch(database: OpenClawAgentDatabase, sessionId: string) {
  function rows() {
    return iterateSqliteQuerySync(
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
  }
  function compressedFacts(reportJson: string | null): SessionTranscriptReportFacts {
    const facts =
      reportJson === null ? undefined : decodeSessionTranscriptReportFacts(JSON.parse(reportJson));
    if (!facts) {
      throw new Error("Invalid compressed transcript report facts");
    }
    return facts;
  }
  let hasRows = false;
  const header = findSessionTranscriptHeader(
    (function* () {
      for (const row of rows()) {
        hasRows = true;
        if (row.event_json !== null) {
          yield JSON.parse(row.event_json) as unknown;
        } else {
          compressedFacts(row.report_json);
        }
      }
    })(),
  );
  if (hasRows) {
    assertCurrentSessionTranscriptHeader(header);
  }
  return new TranscriptReportNavigation(
    (function* () {
      for (const row of rows()) {
        yield {
          seq: row.seq,
          facts:
            row.event_json === null
              ? compressedFacts(row.report_json)
              : projectSessionTranscriptReportFacts(JSON.parse(row.event_json)),
        };
      }
    })(),
  ).facts();
}

function latestCustomReport(
  database: OpenClawAgentDatabase,
  sessionId: string,
  branch: ReturnType<typeof readReportBranch>,
  customTypes: readonly string[],
): CustomMessageReport | undefined {
  for (const entry of branch.path.toReversed()) {
    if (
      entry.type !== "custom_message" ||
      entry.customType === undefined ||
      !customTypes.includes(entry.customType)
    ) {
      continue;
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(transcriptEventJsonSql(database.db).as("event_json"))
        .where("session_id", "=", sessionId)
        .where("seq", "=", entry.seq),
    );
    const record: unknown = row ? JSON.parse(row.event_json) : undefined;
    if (isRecord(record)) {
      return { customType: entry.customType, content: record.content, details: record.details };
    }
  }
  return undefined;
}

export function prepareTranscriptReportSelection(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  selection: TranscriptReportSelection,
): PreparedTranscriptReport {
  const branch = readReportBranch(database, resolved.sessionId);
  const suppressed =
    selection.kind === "assistant"
      ? branch.path.some((entry) => entry.assistantResponseId === selection.responseId)
      : selection.suppressWhenAssistantRun !== undefined &&
        branch.path.some((entry) => entry.assistantRunId === selection.suppressWhenAssistantRun);
  return {
    appendParentId: branch.appendParentId,
    suppressed,
    latest:
      selection.kind === "custom" && !suppressed
        ? latestCustomReport(database, resolved.sessionId, branch, selection.customTypes)
        : undefined,
  };
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

/** Agent execution retains this same-thread shared handle; never open a fallback during a grant. */
export function inspectStartupSessionSettlementOwner(
  resolved: ResolvedTranscriptScope,
  input: StartupSessionSettlement,
): "retained" | "ownerless" {
  const read = withCachedOpenClawStateDatabaseReadOnly<"retained" | "ownerless">(
    (shared) => {
      const lease = readGatewayOwnerLeaseFromDatabase(shared.db);
      if (
        lease?.state !== "live" ||
        lease.pid !== input.observation.gatewayOwner.pid ||
        lease.owner !== input.observation.gatewayOwner.owner
      ) {
        throw new Error("startup Gateway ownership changed or could not be verified");
      }
      return input.kind === "interrupt" &&
        hasSubagentSessionOwnerInDatabase(shared, resolved.sessionKey)
        ? "retained"
        : "ownerless";
    },
    resolveOpenClawStateSqlitePath(resolved.env),
    true,
  );
  if (!read.reused) {
    throw new Error("Startup settlement lost its retained shared-state owner");
  }
  return read.value;
}

/** Startup settles the entry and, for interruption only, its receipt in one writer transaction. */
export function settleStartupSessionInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  input: StartupSessionSettlement,
  projection: { scheduleProjectionReconcile: false; onProjectionReconcileNeeded: () => void },
): Exclude<StartupSessionSettlementOutcome, "retained"> {
  const current = readSessionEntryRow(database, resolved.sessionKey)?.entry;
  const { expected, processStartedAt, endedAt } = input.observation;
  if (
    !current ||
    current.sessionId !== expected.sessionId ||
    current.lifecycleRevision !== expected.lifecycleRevision ||
    current.lifecycleRunId !== expected.lifecycleRunId ||
    current.updatedAt !== expected.updatedAt ||
    current.startedAt !== expected.startedAt ||
    current.archivedAt !== expected.archivedAt ||
    (current.archivedAt !== undefined) !== (input.kind === "archive") ||
    !isStartupSessionSettlementCandidate(current, processStartedAt)
  ) {
    throw new Error("startup session changed before settlement");
  }
  if (input.kind === "archive") {
    const next = { ...current };
    settleArchivedSessionRun(next, endedAt);
    writeSessionEntry(database, resolved.sessionKey, next, { canonicalPreviousEntry: current });
    return "archived";
  }
  const facts = prepareTranscriptReportSelection(database, resolved, {
    kind: "custom",
    customTypes: [input.report.customType],
    suppressWhenAssistantRun: input.runId,
  });
  if (facts.suppressed) {
    return "unchanged";
  }
  writeSessionEntry(
    database,
    resolved.sessionKey,
    {
      ...current,
      status: "interrupted",
      abortedLastRun: true,
      endedAt,
      lastRunError: input.error,
    },
    { canonicalPreviousEntry: current },
  );
  if (isRecord(facts.latest?.details) && facts.latest.details.runId === input.runId) {
    return "interrupted";
  }
  appendSelectedTranscriptReportInTransaction(
    database,
    resolved,
    facts.appendParentId,
    prepareCustomTranscriptReport(input.report, facts.appendParentId),
    projection,
  );
  return "interrupted";
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
  for (const candidate of branch.path.toReversed()) {
    if (candidate.assistantRunId !== partial.runId) {
      continue;
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(transcriptEventJsonSql(database.db).as("event_json"))
        .where("session_id", "=", resolved.sessionId)
        .where("seq", "=", candidate.seq),
    );
    const event: unknown = row ? JSON.parse(row.event_json) : undefined;
    const message = isRecord(event) ? event.message : undefined;
    if (
      !isRecord(message) ||
      readSessionTranscriptRunId(message) !== partial.runId ||
      resolveTerminalAssistantTranscriptRunId(message, partial.runId) === undefined ||
      isOpenClawMessageToolMirrorAssistantMessage(message) ||
      isTranscriptOnlyOpenClawAssistantMessage(message)
    ) {
      continue;
    }
    const metadata = asOptionalRecord(message["__openclaw"]);
    if (metadata?.mirrorOrigin !== undefined && metadata.runTerminal !== true) {
      continue;
    }
    // Commentary, media-only receipts, and empty error rows do not own buffered answer text.
    if (extractAssistantPhaseText(projectAssistantDisplayContent(message))?.trim()) {
      return { skipped: true };
    }
  }
  // Deferred Gateway settlement has no model writer context; recheck durable custody here.
  if (entry.activeWriterRunId !== undefined && entry.activeWriterRunId !== partial.runId) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const append = appendTranscriptMessageInTransaction(
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
