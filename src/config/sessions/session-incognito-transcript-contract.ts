import type { Result } from "@openclaw/normalization-core/result";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import type {
  CustomMessageReport,
  TranscriptReportSelection,
  TranscriptReportWorkerOperations,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import type { readClosedTranscriptTurnInDatabase } from "./session-accessor.transcript-range.js";

type IncognitoTranscriptTarget = {
  sessionKey: string;
  sessionId: string;
  fence: Pick<SessionTranscriptWriteScope, "expectedLifecycleRevision" | "expectedWriterRunId">;
};

type IncognitoReportPreparation = {
  selection: TranscriptReportSelection;
  version: SessionTranscriptContextVersion;
};

export type IncognitoTranscriptOperations = {
  [Key in "assistant" | "abortedPartial" as `session.report.${Key}`]: {
    input: IncognitoTranscriptTarget & { report: TranscriptReportWorkerOperations[Key]["input"] };
    output: TranscriptReportWorkerOperations[Key]["output"];
  };
} & {
  "session.report.latestCustomReport": {
    input: IncognitoTranscriptTarget & { customTypes: readonly string[] };
    output: Result<CustomMessageReport | undefined, TranscriptAppendRefusal>;
  };
  "session.report.prepare": {
    input: IncognitoTranscriptTarget & { selection: TranscriptReportSelection };
    output: Result<
      {
        prepared: IncognitoReportPreparation;
        facts: Extract<
          TranscriptReportWorkerOperations["prepare"]["output"],
          { ok: true }
        >["value"];
      },
      TranscriptAppendRefusal
    >;
  };
  "session.report.append": {
    input: IncognitoTranscriptTarget & {
      prepared: IncognitoReportPreparation;
      report: TranscriptReportWorkerOperations["append"]["input"];
    };
    output: TranscriptReportWorkerOperations["append"]["output"];
  };
  "session.message.append": {
    input: IncognitoTranscriptTarget & {
      message: Record<string, unknown>;
      parentId?: string | null;
    };
    output: Result<
      {
        append: TranscriptMessageAppendResult<Record<string, unknown>> | undefined;
        projectionNeedsReconcile: boolean;
      },
      TranscriptAppendRefusal
    >;
  };
  "session.turn.read": {
    input: IncognitoTranscriptTarget & Parameters<typeof readClosedTranscriptTurnInDatabase>[1];
    output: ReturnType<typeof readClosedTranscriptTurnInDatabase>;
  };
};

export function isIncognitoTranscriptCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoTranscriptOperations> {
  return (
    command.type.startsWith("session.report.") ||
    command.type === "session.message.append" ||
    command.type === "session.turn.read"
  );
}

export function isIncognitoTranscriptWrite(type: keyof IncognitoTranscriptOperations): boolean {
  return (
    type !== "session.report.prepare" &&
    type !== "session.report.latestCustomReport" &&
    type !== "session.turn.read"
  );
}
