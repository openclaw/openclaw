import type { Result } from "@openclaw/normalization-core/result";
import type {
  ApplyTranscriptCommitResult,
  CommittedAgentMessage,
  TranscriptCommitInput,
} from "../../gateway/worker-environments/transcript-commit.types.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  SessionGoalManagementInput,
  SessionGoalManagementCommit,
  SessionGoalOperationLookup,
  SessionGoalOperationResult,
} from "./goals-operations.types.js";
import type {
  TranscriptEvent,
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
import type { ResolvedSessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import {
  isIncognitoManagerCommand,
  isIncognitoManagerWrite,
  type IncognitoManagerOperations,
} from "./session-incognito-manager-contract.js";
import type { IncognitoTranscriptLockOperations } from "./session-incognito-transcript-lock-contract.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";
import type {
  RefusedTranscriptOwnerSource,
  ManualTranscriptCompactPreparation,
  ManualTranscriptCompactCommit,
  SessionMessageRewriteSelection,
  SessionMessageRewriteSnapshot,
  SessionMessageRewriteCommitted,
  SessionTranscriptEventCommitted,
  SessionTranscriptCorrectionCommitted,
  SessionTranscriptCorrectionInput,
} from "./session-transcript-mutation.types.js";

type IncognitoTranscriptTarget = {
  sessionKey: string;
  sessionId: string;
  fence: Pick<
    SessionTranscriptWriteScope,
    "expectedLifecycleRevision" | "expectedWriterRunId" | "expectedOwner"
  >;
};

type IncognitoReportPreparation = {
  selection: TranscriptReportSelection;
  version: SessionTranscriptContextVersion;
};

export type IncognitoTranscriptOperations = IncognitoManagerOperations &
  IncognitoTranscriptLockOperations & {
    [Key in "assistant" | "abortedPartial" as `session.report.${Key}`]: {
      input: IncognitoTranscriptTarget & { report: TranscriptReportWorkerOperations[Key]["input"] };
      output: TranscriptReportWorkerOperations[Key]["output"];
    };
  } & {
    "session.workerTranscript.commit": {
      input: IncognitoTranscriptTarget & {
        batch: Omit<TranscriptCommitInput, "scope">;
        preparedMessages: readonly CommittedAgentMessage[];
      };
      output: { result: ApplyTranscriptCommitResult; projectionNeedsReconcile: boolean };
    };
    "session.goal.mutate": {
      input: IncognitoTranscriptTarget &
        SessionGoalManagementInput & { sources: SessionSourcePredicate[] };
      output: SessionGoalManagementCommit | RefusedTranscriptOwnerSource;
    };
    "session.manualCompact.prepare": {
      input: IncognitoTranscriptTarget & { sources: SessionSourcePredicate[] };
      output:
        | (ManualTranscriptCompactPreparation & { sourceValidation: SessionSourceValidation })
        | RefusedTranscriptOwnerSource;
    };
    "session.manualCompact.commit": {
      input: IncognitoTranscriptTarget & {
        prepared: ManualTranscriptCompactPreparation;
        retainedEvents: TranscriptEvent[];
        nowMs?: number;
        sources: SessionSourcePredicate[];
      };
      output:
        | (ManualTranscriptCompactCommit & {
            projectionNeedsReconcile: boolean;
          })
        | RefusedTranscriptOwnerSource;
    };
    "session.keyById.read": {
      input: { sessionId: string };
      output: string | undefined;
    };
    "session.runtimeTarget.read": {
      input: IncognitoTranscriptTarget & { keyFormat?: "agent-qualified" };
      output: ResolvedSessionTranscriptRuntimeTarget;
    };
    "session.goalReceipt.read": {
      input: IncognitoTranscriptTarget & SessionGoalOperationLookup;
      output: SessionGoalOperationResult | undefined;
    };
    "session.rewrite.prepare": {
      input: IncognitoTranscriptTarget & Omit<SessionMessageRewriteSelection, "scope">;
      output: SessionMessageRewriteSnapshot | null;
    };
    "session.rewrite.commit": {
      input: IncognitoTranscriptTarget &
        Omit<SessionMessageRewriteSelection, "scope"> & {
          expected: SessionMessageRewriteSnapshot;
          message: unknown;
        };
      output: SessionMessageRewriteCommitted;
    };
    "session.event.append": {
      input: IncognitoTranscriptTarget & { eventJson: string };
      output: SessionTranscriptEventCommitted;
    };
    "session.correction.prepare": {
      input: IncognitoTranscriptTarget & {
        afterSeq?: number;
        selectedLifecycleRevision: string | null;
        ownerSources?: SessionSourcePredicate[];
      };
      output:
        | {
            rows: Array<{ seq: number; eventJson: string }>;
            version: SessionTranscriptContextVersion;
            sourceValidation: SessionSourceValidation;
          }
        | RefusedTranscriptOwnerSource;
    };
    "session.correction.commit": {
      input: IncognitoTranscriptTarget &
        Omit<SessionTranscriptCorrectionInput, "scope"> & {
          selectedLifecycleRevision: string | null;
          ownerSources?: SessionSourcePredicate[];
        };
      output: SessionTranscriptCorrectionCommitted | RefusedTranscriptOwnerSource;
    };
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
    isIncognitoManagerCommand(command) ||
    command.type.startsWith("session.report.") ||
    command.type.startsWith("session.lock.") ||
    command.type.startsWith("session.manualCompact.") ||
    command.type === "session.goal.mutate" ||
    command.type.startsWith("session.correction.") ||
    command.type.startsWith("session.rewrite.") ||
    command.type === "session.runtimeTarget.read" ||
    command.type === "session.keyById.read" ||
    command.type === "session.goalReceipt.read" ||
    command.type === "session.event.append" ||
    command.type === "session.message.append" ||
    command.type === "session.turn.read" ||
    command.type === "session.workerTranscript.commit"
  );
}

export function isIncognitoTranscriptWrite(type: keyof IncognitoTranscriptOperations): boolean {
  const command = { type };
  if (isIncognitoManagerCommand(command)) {
    return isIncognitoManagerWrite(command.type);
  }
  return (
    type !== "session.lock.events" &&
    type !== "session.lock.facts" &&
    type !== "session.manualCompact.prepare" &&
    type !== "session.correction.prepare" &&
    type !== "session.rewrite.prepare" &&
    type !== "session.runtimeTarget.read" &&
    type !== "session.keyById.read" &&
    type !== "session.goalReceipt.read" &&
    type !== "session.report.prepare" &&
    type !== "session.report.latestCustomReport" &&
    type !== "session.turn.read"
  );
}

export function isIncognitoTranscriptReceiptCommand(
  type: string,
): type is
  | "session.lock.replace"
  | "session.workerTranscript.commit"
  | "session.goal.mutate"
  | "session.manualCompact.commit"
  | "session.rewrite.commit"
  | "session.event.append"
  | "session.correction.commit" {
  return (
    type === "session.lock.replace" ||
    type === "session.workerTranscript.commit" ||
    type === "session.goal.mutate" ||
    type === "session.manualCompact.commit" ||
    type === "session.rewrite.commit" ||
    type === "session.event.append" ||
    type === "session.correction.commit"
  );
}
