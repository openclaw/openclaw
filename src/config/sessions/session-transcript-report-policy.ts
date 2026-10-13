import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
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
import type {
  CustomMessageReport,
  PreparedTranscriptReport,
  TranscriptReportSelection,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { SessionEntryNavigation, type SessionNavigationEntry } from "./session-entry-navigation.js";
import type { SessionTranscriptReportFacts } from "./session-transcript-report-facts.js";

type ReportNavigationEntry = SessionNavigationEntry & {
  seq: number;
  customType?: string;
  assistantResponseId?: string;
  assistantRunId?: string;
};

export class TranscriptReportNavigation extends SessionEntryNavigation<ReportNavigationEntry> {
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

function latestCustomReport(
  branch: ReturnType<TranscriptReportNavigation["facts"]>,
  readEvent: (seq: number) => Record<string, unknown> | undefined,
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
    const record = readEvent(entry.seq);
    if (record) {
      return { customType: entry.customType, content: record.content, details: record.details };
    }
  }
  return undefined;
}

export function selectTranscriptReport(
  branch: ReturnType<TranscriptReportNavigation["facts"]>,
  readEvent: (seq: number) => Record<string, unknown> | undefined,
  selection: TranscriptReportSelection,
): PreparedTranscriptReport {
  const suppressed =
    selection.kind === "assistant"
      ? branch.path.some((entry) => entry.assistantResponseId === selection.responseId)
      : selection.suppressWhenAssistantRun !== undefined &&
        branch.path.some((entry) => {
          if (entry.assistantRunId !== selection.suppressWhenAssistantRun) {
            return false;
          }
          // Progress and commentary cannot stand in for a durable failure outcome.
          const message = readEvent(entry.seq)?.message;
          return isRecord(message) && message.stopReason === "error";
        });
  return {
    appendParentId: branch.appendParentId,
    suppressed,
    latest:
      selection.kind === "custom" && !suppressed
        ? latestCustomReport(branch, readEvent, selection.customTypes)
        : undefined,
  };
}

/** Only a settled visible answer owns buffered text; commentary and mirror receipts do not. */
export function hasSettledTranscriptAssistant(
  branch: ReturnType<TranscriptReportNavigation["facts"]>,
  readEvent: (seq: number) => Record<string, unknown> | undefined,
  runId: string,
): boolean {
  return branch.path.toReversed().some((candidate) => {
    if (candidate.assistantRunId !== runId) {
      return false;
    }
    const message = readEvent(candidate.seq)?.message;
    if (
      !isRecord(message) ||
      readSessionTranscriptRunId(message) !== runId ||
      resolveTerminalAssistantTranscriptRunId(message, runId) === undefined ||
      isOpenClawMessageToolMirrorAssistantMessage(message) ||
      isTranscriptOnlyOpenClawAssistantMessage(message)
    ) {
      return false;
    }
    const metadata = asOptionalRecord(message["__openclaw"]);
    return (
      !(metadata?.mirrorOrigin !== undefined && metadata.runTerminal !== true) &&
      Boolean(extractAssistantPhaseText(projectAssistantDisplayContent(message))?.trim())
    );
  });
}
