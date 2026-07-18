// Durable parent/child fan-in policy helpers.
import type {
  DurableRuntimeLink,
  DurableRuntimeRun,
  DurableRuntimeStepStatus,
  DurableRuntimeStore,
} from "./types.js";

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

export function buildDurableFanInGroupId(params: {
  parentRuntimeRunId: string;
  parentStepId: string;
}): string {
  return `fan-in:${params.parentRuntimeRunId}:${params.parentStepId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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
  return undefined;
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

function isTerminalRun(run: DurableRuntimeRun | undefined): boolean {
  return (
    run?.status === "succeeded" ||
    run?.status === "failed" ||
    run?.status === "cancelled" ||
    run?.status === "lost"
  );
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
  return { status: "waiting", total, succeeded, failed, terminal, ready: false };
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
  const existingStep = params.store
    .listSteps(params.parentRuntimeRunId)
    .find((step) => step.stepId === params.parentStepId);
  const existingMetadata = isRecord(existingStep?.metadata) ? existingStep.metadata : {};
  const fanInGroupId =
    optionalString(existingMetadata.fanInGroupId) ??
    optionalString(childLinks.find((link) => isRecord(link.metadata))?.metadata?.fanInGroupId) ??
    buildDurableFanInGroupId({
      parentRuntimeRunId: params.parentRuntimeRunId,
      parentStepId: params.parentStepId,
    });
  const result = computeFanInResult({
    links: childLinks,
    policy: params.policy,
  });
  const outcomes = summarizeTerminalOutcomes(childLinks);
  const parentRun = params.store.getRun(params.parentRuntimeRunId);
  const parentAlreadyTerminal = isTerminalRun(parentRun);
  const terminalizesParent =
    result.status === "failed" && params.policy === "fail_parent_on_child_failure";
  const terminalizeFanInStep = parentAlreadyTerminal || terminalizesParent;
  const stepStatus = terminalizeFanInStep ? result.status : "waiting";
  const stepRecoveryState = terminalizeFanInStep ? "terminal" : "waiting_child";

  params.store.updateStep({
    runtimeRunId: params.parentRuntimeRunId,
    stepId: params.parentStepId,
    status: stepStatus,
    recoveryState: stepRecoveryState,
    completedAt: terminalizeFanInStep && result.ready ? now : null,
    metadata: {
      ...existingMetadata,
      policy: params.policy,
      fanInGroupId,
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      terminal: result.terminal,
      ready: result.ready,
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
      fanInGroupId,
      outcomes,
    },
  });

  if (parentAlreadyTerminal) {
    return result;
  }

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
