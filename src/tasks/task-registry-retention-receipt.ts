import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TaskRetentionSource } from "./task-registry-retention-source.js";
import {
  prepareTaskRetention,
  type TaskRetentionInput,
  type TaskRetentionResult,
} from "./task-registry-retention.operation.js";

type TaskRetentionCommit = Exclude<TaskRetentionResult, { kind: "unchanged" }>;

type TaskRetentionCommitFacts = {
  kind: "task-retention-commit";
  taskId: string;
  sourceVersion: string;
  now: number;
  cronHistoryOverflow: boolean;
  outcome: TaskRetentionCommit["kind"];
};

export type TaskRetentionWriteResult = { kind: "unchanged" } | TaskRetentionCommitFacts;

/** The native receipt binds one complete prepared source without transporting it twice. */
export function captureTaskRetentionCommit(
  input: TaskRetentionInput,
  result: TaskRetentionCommit,
): TaskRetentionCommitFacts {
  return {
    kind: "task-retention-commit",
    taskId: input.taskId,
    sourceVersion: input.sourceVersion,
    now: input.now,
    cronHistoryOverflow: input.cronHistoryOverflow,
    outcome: result.kind,
  };
}

export function readTaskRetentionCommit(
  facts: unknown,
  input: TaskRetentionInput,
  source: TaskRetentionSource,
): TaskRetentionCommit | undefined {
  if (facts === undefined) {
    return undefined;
  }
  if (
    !isRecord(facts) ||
    facts.kind !== "task-retention-commit" ||
    facts.taskId !== input.taskId ||
    facts.sourceVersion !== input.sourceVersion ||
    source.version !== input.sourceVersion ||
    facts.now !== input.now ||
    facts.cronHistoryOverflow !== input.cronHistoryOverflow
  ) {
    throw new Error("Task retention commit differs from its retained operation");
  }
  const result = prepareTaskRetention(source.task, input);
  if (result.kind === "unchanged" || facts.outcome !== result.kind) {
    throw new Error("Task retention commit changed its admitted outcome");
  }
  return result;
}
