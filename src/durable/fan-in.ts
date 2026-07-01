// Durable parent/child fan-in policy helpers.
import type { DurableRuntimeLink, DurableRuntimeStepStatus, DurableRuntimeStore } from "./types.js";

export type DurableChildTerminalOutcomeStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "overflowed"
  | "lost"
  | "cancelled"
  | "blocked"
  | "unknown_after_side_effect"
  | "announce_failed";

export type DurableFanInPolicy =
  | "all_succeeded"
  | "all_terminal"
  | "first_success"
  | "continue_on_child_failure"
  | "fail_parent_on_child_failure";

export type DurableFanInResult = {
  status: DurableRuntimeStepStatus;
  total: number;
  succeeded: number;
  failed: number;
  terminal: number;
  ready: boolean;
};

function normalizeChildTerminalOutcome(
  value: unknown,
): DurableChildTerminalOutcomeStatus | undefined {
  switch (value) {
    case "succeeded":
    case "failed":
    case "timed_out":
    case "overflowed":
    case "lost":
    case "cancelled":
    case "blocked":
    case "unknown_after_side_effect":
    case "announce_failed":
      return value;
    default:
      return undefined;
  }
}

export function durableChildTerminalOutcomeFromLink(
  link: DurableRuntimeLink,
): DurableChildTerminalOutcomeStatus | undefined {
  const metadataOutcome = normalizeChildTerminalOutcome(link.metadata?.terminalOutcome);
  if (metadataOutcome) {
    return metadataOutcome;
  }
  switch (link.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "lost":
      return "lost";
    case "pending":
    case "running":
      return undefined;
  }
}

function summarizeTerminalOutcomes(
  links: DurableRuntimeLink[],
): Partial<Record<DurableChildTerminalOutcomeStatus, number>> {
  const summary: Partial<Record<DurableChildTerminalOutcomeStatus, number>> = {};
  for (const link of links) {
    const outcome = durableChildTerminalOutcomeFromLink(link);
    if (!outcome) {
      continue;
    }
    summary[outcome] = (summary[outcome] ?? 0) + 1;
  }
  return summary;
}

function computeFanInResult(params: {
  links: DurableRuntimeLink[];
  policy: DurableFanInPolicy;
}): DurableFanInResult {
  const outcomes = params.links
    .map((link) => durableChildTerminalOutcomeFromLink(link))
    .filter((outcome): outcome is DurableChildTerminalOutcomeStatus => Boolean(outcome));
  const total = params.links.length;
  const succeeded = outcomes.filter((status) => status === "succeeded").length;
  const failed = outcomes.filter((status) => status !== "succeeded").length;
  const terminal = outcomes.length;

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
  store: DurableRuntimeStore;
  parentRuntimeRunId: string;
  parentStepId: string;
  policy: DurableFanInPolicy;
  now?: number;
}): DurableFanInResult {
  const now = params.now ?? Date.now();
  const childLinks = params.store
    .listChildLinks(params.parentRuntimeRunId)
    .filter((link) => link.parentStepId === params.parentStepId);
  const result = computeFanInResult({
    links: childLinks,
    policy: params.policy,
  });
  const outcomes = summarizeTerminalOutcomes(childLinks);

  params.store.updateStep({
    runtimeRunId: params.parentRuntimeRunId,
    stepId: params.parentStepId,
    status: result.status,
    recoveryState: result.status === "waiting" ? "waiting_child" : "terminal",
    completedAt: result.ready ? now : null,
    metadata: {
      policy: params.policy,
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      terminal: result.terminal,
      outcomes,
    },
    now,
  });

  params.store.appendEvent({
    runtimeRunId: params.parentRuntimeRunId,
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
      outcomes,
    },
  });

  if (result.status === "waiting") {
    params.store.updateRun({
      runtimeRunId: params.parentRuntimeRunId,
      status: "waiting_child",
      recoveryState: "waiting_child",
      completedAt: null,
      now,
    });
  } else if (result.status === "succeeded") {
    params.store.updateRun({
      runtimeRunId: params.parentRuntimeRunId,
      status: "queued",
      recoveryState: "runnable",
      now,
    });
  } else if (result.status === "failed" && params.policy === "fail_parent_on_child_failure") {
    params.store.updateRun({
      runtimeRunId: params.parentRuntimeRunId,
      status: "failed",
      recoveryState: "terminal",
      completedAt: now,
      now,
    });
  }

  return result;
}
