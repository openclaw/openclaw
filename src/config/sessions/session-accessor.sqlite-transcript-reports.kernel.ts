import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { AssistantMessage } from "../../llm/types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptMessageInTransaction,
  type PreparedTranscriptMessageAppend,
} from "./session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventInTransaction,
  ensureTranscriptHeader,
} from "./session-accessor.sqlite-transcript-store.js";
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
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export type CustomMessageReport = { customType: string; content: unknown; details?: unknown };
export type CustomMessageReportAppend = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};
export type TranscriptReport =
  | { kind: "assistant"; message: AssistantMessage & { responseId: string } }
  | {
      kind: "custom";
      customTypes: readonly string[];
      suppressWhenAssistantRun?: string;
      /** Pure selection; a definite concurrent transcript change may repeat it. */
      selectReport: (
        latest: CustomMessageReport | undefined,
      ) => CustomMessageReportAppend | undefined;
    };

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

export type SelectedTranscriptReport =
  | Extract<TranscriptReport, { kind: "assistant" }>
  | { kind: "custom"; eventJson: string };

export type TranscriptReportSelection =
  | { kind: "assistant"; responseId: string }
  | Pick<
      Extract<TranscriptReport, { kind: "custom" }>,
      "kind" | "customTypes" | "suppressWhenAssistantRun"
    >;

export function prepareTranscriptReportSelection(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  selection: TranscriptReportSelection,
) {
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
  ensureTranscriptHeader(database, resolved, undefined);
  const event: unknown = JSON.parse(report.eventJson);
  const appended = appendTranscriptEventInTransaction(database, resolved, event, {
    ...projection,
    eventJson: report.eventJson,
  });
  if (!appended) {
    throw new Error("Session transcript report was not appended");
  }
}
