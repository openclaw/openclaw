import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { AssistantMessage } from "../../llm/types.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventInTransaction,
  ensureTranscriptHeader,
} from "./session-accessor.sqlite-transcript-store.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
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
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

type CustomMessageReport = { customType: string; content: unknown; details?: unknown };
type CustomMessageReportAppend = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};
type TranscriptReport =
  | { kind: "assistant"; message: AssistantMessage & { responseId: string } }
  | {
      kind: "custom";
      customTypes: readonly string[];
      suppressWhenAssistantRun?: string;
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

async function withCurrentTranscript<T>(
  scope: SessionTranscriptWriteScope,
  run: (database: OpenClawAgentDatabase, resolved: ResolvedTranscriptScope) => T,
): Promise<Result<T, TranscriptAppendRefusal>> {
  // Capture the logical store identity before SQLite resolves a physical path,
  // or inherited writer fences would stop matching after the queue wait.
  const fenced = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fenced);
  return runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          assertOwnedTranscriptWriteCommit(fenced);
          const refusal = resolveTranscriptAppendRefusal(
            readSessionEntryRow(database, resolved.sessionKey)?.entry,
            resolved,
            fenced,
          );
          if (refusal) {
            if (fenced.expectedWriterRunId !== undefined) {
              throw new SessionTranscriptWriterClaimReboundError(refusal);
            }
            return err(refusal);
          }
          const result = run(database, resolved);
          assertOwnedTranscriptWriteCommit(fenced);
          const rebound = resolveTranscriptAppendRefusal(
            readSessionEntryRow(database, resolved.sessionKey)?.entry,
            resolved,
            fenced,
          );
          if (rebound) {
            throw new SessionTranscriptWriterClaimReboundError(rebound);
          }
          return ok(result);
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.report" },
      ),
    "session.transcript.report",
  );
}

/** Reads the latest matching custom report from the active branch in one snapshot. */
export async function readLatestSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  customTypes: readonly string[],
): Promise<Result<CustomMessageReport | undefined, TranscriptAppendRefusal>> {
  return withCurrentTranscript(scope, (database, resolved) =>
    latestCustomReport(
      database,
      resolved.sessionId,
      readReportBranch(database, resolved.sessionId),
      customTypes,
    ),
  );
}

/** Selects and appends one report atomically; Gateway policy only sees report facts. */
export async function appendSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  report: TranscriptReport,
): Promise<Result<void, TranscriptAppendRefusal>> {
  return withCurrentTranscript(scope, (database, resolved) => {
    const branch = readReportBranch(database, resolved.sessionId);
    if (report.kind === "assistant") {
      const exists = branch.path.some(
        (entry) => entry.assistantResponseId === report.message.responseId,
      );
      if (exists) {
        return;
      }
      appendTranscriptMessageInTransaction(database, resolved, {
        message: applyAssistantDeliveryDirectives(report.message),
        parentId: branch.appendParentId,
      });
      return;
    }
    if (
      report.suppressWhenAssistantRun !== undefined &&
      branch.path.some((entry) => entry.assistantRunId === report.suppressWhenAssistantRun)
    ) {
      return;
    }
    const selected = report.selectReport(
      latestCustomReport(database, resolved.sessionId, branch, report.customTypes),
    );
    if (!selected) {
      return;
    }
    // Query and append share the committed cursor. Existing rows are never
    // retained as a full history or rewritten when a report is appended.
    ensureTranscriptHeader(database, resolved, undefined);
    const appended = appendTranscriptEventInTransaction(database, resolved, {
      type: "custom_message",
      ...selected,
      id: randomUUID(),
      parentId: branch.appendParentId,
      timestamp: new Date().toISOString(),
    });
    if (!appended) {
      throw new Error("Session transcript report was not appended");
    }
  });
}
