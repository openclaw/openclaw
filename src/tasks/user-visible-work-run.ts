import { isTimeoutError } from "../agents/failover-error.js";
import { isAbortError } from "../infra/unhandled-rejections.js";
import type { DetachedRunningTaskCreateParams } from "./detached-task-runtime-contract.js";
import { createRunningTaskRun, finalizeTaskRunByRunId } from "./detached-task-runtime.js";
import { judgeTaskCompletion } from "./task-completion-judge.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

export type UserVisibleWorkTerminalStatus = Extract<
  TaskStatus,
  "succeeded" | "failed" | "timed_out" | "cancelled"
>;

const ARTIFACT_REQUEST_RE =
  /\b(video|game|rom|file|download|attachment|image|picture|photo|song|music|audio|pdf|docx|spreadsheet|presentation|app|project|artifact)\b/i;

export function resolveFailedUserVisibleWorkStatus(error: unknown): UserVisibleWorkTerminalStatus {
  return isAbortError(error) || isTimeoutError(error) ? "timed_out" : "failed";
}

export function inferExpectedDeliverableFromUserRequest(message: string): string {
  return ARTIFACT_REQUEST_RE.test(message) ? "requested artifact" : "direct answer";
}

export const USER_VISIBLE_WORK_ACCEPTANCE_CRITERIA = [
  "Assistant must provide a final answer or explicit blocker.",
  "Artifact requests must include a recorded artifact or download/link evidence.",
  "Judge must approve before the task is treated as complete.",
] as const;

export function createUserVisibleWorkRun(
  params: Omit<
    DetachedRunningTaskCreateParams,
    "expectedDeliverable" | "acceptanceCriteria" | "judgeStatus"
  > & {
    expectedDeliverable?: string;
    acceptanceCriteria?: string[];
  },
): TaskRecord {
  const expectedDeliverable =
    params.expectedDeliverable ?? inferExpectedDeliverableFromUserRequest(params.task);
  return createRunningTaskRun({
    ...params,
    userVisible: params.userVisible ?? true,
    expectedDeliverable,
    acceptanceCriteria: params.acceptanceCriteria ?? [...USER_VISIBLE_WORK_ACCEPTANCE_CRITERIA],
    judgeStatus: "pending",
  });
}

export function collectFinalTextFromAgentResult(result: unknown): string {
  const maybeResult =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as {
          payloads?: Array<{ text?: unknown }>;
          meta?: { finalAssistantVisibleText?: unknown };
        })
      : undefined;
  const payloadText = (maybeResult?.payloads ?? [])
    .map((payload) => (typeof payload.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (payloadText) {
    return payloadText;
  }
  return typeof maybeResult?.meta?.finalAssistantVisibleText === "string"
    ? maybeResult.meta.finalAssistantVisibleText.trim()
    : "";
}

export function collectArtifactIdsFromAgentResult(result: unknown): string[] {
  const maybeResult =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as { payloads?: Array<Record<string, unknown>> })
      : undefined;
  const ids: string[] = [];
  for (const payload of maybeResult?.payloads ?? []) {
    for (const key of ["artifactId", "mediaUrl", "mediaPath", "fileName", "url"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) {
        ids.push(value.trim());
      }
    }
  }
  return [...new Set(ids)];
}

export function finalizeUserVisibleWorkRun(params: {
  runId: string;
  status: UserVisibleWorkTerminalStatus;
  error?: string;
  terminalSummary?: string;
  finalText?: string;
  userRequest?: string;
  expectedDeliverable?: string;
  artifactIds?: string[];
  runtime?: "cli";
}): void {
  try {
    const judge =
      params.userRequest && params.status === "succeeded"
        ? judgeTaskCompletion({
            userRequest: params.userRequest,
            finalText: params.finalText,
            expectedDeliverable: params.expectedDeliverable,
            artifactIds: params.artifactIds,
            status: params.status,
            error: params.error,
          })
        : undefined;
    const blockedByJudge = judge && !judge.approved;
    finalizeTaskRunByRunId({
      runId: params.runId,
      runtime: params.runtime ?? "cli",
      status: blockedByJudge ? "succeeded" : params.status,
      endedAt: Date.now(),
      ...(params.error !== undefined ? { error: params.error } : {}),
      terminalSummary:
        blockedByJudge && judge?.blockedReason
          ? judge.blockedReason
          : (params.terminalSummary ?? params.finalText),
      ...(blockedByJudge ? { terminalOutcome: "blocked" as const } : {}),
      ...(judge?.artifactIds.length ? { artifactIds: judge.artifactIds } : {}),
      ...(judge
        ? {
            judgeStatus: judge.approved ? ("approved" as const) : ("rejected" as const),
            judgeVerdict: judge.verdict.verdict,
            judgeReason: judge.verdict.reason,
            blockedReason: judge.blockedReason,
          }
        : {}),
    });
  } catch {
    // Best-effort only: task tracking must not block agent/chat runs.
  }
}
