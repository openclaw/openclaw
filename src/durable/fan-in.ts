// Durable parent/child fan-in policy helpers.
import type {
  DurableWorkflowLinkStatus,
  DurableWorkflowStepStatus,
  DurableWorkflowStore,
} from "./types.js";

export type DurableFanInPolicy =
  | "all_succeeded"
  | "all_terminal"
  | "first_success"
  | "continue_on_child_failure"
  | "fail_parent_on_child_failure";

export type DurableFanInResult = {
  status: DurableWorkflowStepStatus;
  total: number;
  succeeded: number;
  failed: number;
  terminal: number;
  ready: boolean;
};

function isTerminalLinkStatus(status: DurableWorkflowLinkStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function computeFanInResult(params: {
  statuses: DurableWorkflowLinkStatus[];
  policy: DurableFanInPolicy;
}): DurableFanInResult {
  const total = params.statuses.length;
  const succeeded = params.statuses.filter((status) => status === "succeeded").length;
  const failed = params.statuses.filter(
    (status) => status === "failed" || status === "cancelled" || status === "lost",
  ).length;
  const terminal = params.statuses.filter(isTerminalLinkStatus).length;

  if (total === 0) {
    return { status: "waiting", total, succeeded, failed, terminal, ready: false };
  }

  switch (params.policy) {
    case "all_succeeded":
      if (failed > 0) {
        return { status: "failed", total, succeeded, failed, terminal, ready: true };
      }
      return {
        status: succeeded === total ? "succeeded" : "waiting",
        total,
        succeeded,
        failed,
        terminal,
        ready: succeeded === total,
      };
    case "all_terminal":
    case "continue_on_child_failure":
      return {
        status: terminal === total ? "succeeded" : "waiting",
        total,
        succeeded,
        failed,
        terminal,
        ready: terminal === total,
      };
    case "first_success":
      if (succeeded > 0) {
        return { status: "succeeded", total, succeeded, failed, terminal, ready: true };
      }
      return {
        status: terminal === total ? "failed" : "waiting",
        total,
        succeeded,
        failed,
        terminal,
        ready: terminal === total,
      };
    case "fail_parent_on_child_failure":
      if (failed > 0) {
        return { status: "failed", total, succeeded, failed, terminal, ready: true };
      }
      return {
        status: succeeded === total ? "succeeded" : "waiting",
        total,
        succeeded,
        failed,
        terminal,
        ready: succeeded === total,
      };
  }
}

export function reconcileDurableFanIn(params: {
  store: DurableWorkflowStore;
  parentWorkflowRunId: string;
  parentStepId: string;
  policy: DurableFanInPolicy;
  now?: number;
}): DurableFanInResult {
  const now = params.now ?? Date.now();
  const childLinks = params.store
    .listChildLinks(params.parentWorkflowRunId)
    .filter((link) => link.parentStepId === params.parentStepId);
  const result = computeFanInResult({
    statuses: childLinks.map((link) => link.status),
    policy: params.policy,
  });

  params.store.updateStep({
    workflowRunId: params.parentWorkflowRunId,
    stepId: params.parentStepId,
    status: result.status,
    recoveryState: result.status === "waiting" ? "waiting_child" : "terminal",
    ...(result.ready ? { completedAt: now } : {}),
    metadata: {
      policy: params.policy,
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      terminal: result.terminal,
    },
    now,
  });

  params.store.appendEvent({
    workflowRunId: params.parentWorkflowRunId,
    eventType: result.ready
      ? result.status === "succeeded"
        ? "fan_in.ready"
        : "fan_in.failed"
      : "fan_in.partial",
    eventTime: now,
    stepId: params.parentStepId,
    payload: {
      policy: params.policy,
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      terminal: result.terminal,
    },
  });

  if (result.status === "succeeded") {
    params.store.updateRun({
      workflowRunId: params.parentWorkflowRunId,
      status: "queued",
      recoveryState: "runnable",
      now,
    });
  } else if (result.status === "failed" && params.policy === "fail_parent_on_child_failure") {
    params.store.updateRun({
      workflowRunId: params.parentWorkflowRunId,
      status: "failed",
      recoveryState: "terminal",
      completedAt: now,
      now,
    });
  }

  return result;
}
