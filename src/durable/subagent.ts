import { createHash } from "node:crypto";
import { isDurableRuntimesEnabled } from "./config.js";
import {
  buildDurableFanInGroupId,
  reconcileDurableFanIn,
  type DurableFanInPolicy,
} from "./fan-in.js";
import {
  isDurableResultMailboxAcknowledged,
  recordDurableResultMailboxDeliveryAttempt,
  upsertDurableChildResultMailbox,
} from "./result-mailbox.js";
import {
  DURABLE_AGENT_TURN_OPERATION_KIND,
  DURABLE_SUBAGENT_RUN_OPERATION_KIND,
} from "./runtime-ids.js";
import { openDurableRuntimeStore } from "./store-factory.js";
import type {
  DurableRuntimeLinkStatus,
  DurableRuntimeRun,
  DurableRuntimeRunStatus,
  DurableRuntimeStore,
} from "./types.js";
import {
  recordDurableWakeForChildTerminalFact,
  recordDurableWakeForDeliveryUnknownFact,
  recordDurableWakeForSubagentParentBindingMissing,
} from "./wake-producers.js";
const SUBAGENT_PARENT_STEP_ID = "subagents";
const SUBAGENT_ANNOUNCE_IDEMPOTENCY_PREFIX = "announce:v1:";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? sha256(normalized) : undefined;
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // Durable mirroring must never break the live subagent runtime.
  }
}

function isSubagentAnnounceContinuationRun(run: DurableRuntimeRun): boolean {
  return run.idempotencyKey?.startsWith(SUBAGENT_ANNOUNCE_IDEMPOTENCY_PREFIX) === true;
}

type DurableParentBindingResult =
  | {
      status: "linked";
      parent: DurableRuntimeRun;
      reason: "requester_run_id_match" | "newest_same_session_fallback";
      candidateCount: number;
    }
  | {
      status: "missing";
      reason:
        | "requester_run_id_not_found"
        | "no_open_parent_for_session"
        | "no_requester_session_key";
      candidateCount: number;
    };

function findOpenParentRun(params: {
  store: DurableRuntimeStore;
  requesterSessionKey: string;
  requesterRunId?: string;
}): DurableParentBindingResult {
  if (!params.requesterSessionKey.trim()) {
    return { status: "missing", reason: "no_requester_session_key", candidateCount: 0 };
  }
  const requesterRunId = params.requesterRunId?.trim();
  const candidates = params.store
    .listOpenRuns({ operationKind: DURABLE_AGENT_TURN_OPERATION_KIND, limit: 5000 })
    .filter(
      (run) =>
        !isSubagentAnnounceContinuationRun(run) &&
        (run.sourceRef === params.requesterSessionKey ||
          run.metadata?.sessionKey === params.requesterSessionKey),
    );
  if (requesterRunId) {
    const exactRun = candidates.find((run) => run.idempotencyKey === requesterRunId);
    if (exactRun) {
      return {
        status: "linked",
        parent: exactRun,
        reason: "requester_run_id_match",
        candidateCount: candidates.length,
      };
    }
    return {
      status: "missing",
      reason: "requester_run_id_not_found",
      candidateCount: candidates.length,
    };
  }
  const parent = candidates.toSorted((a, b) => {
    const createdDelta = b.createdAt - a.createdAt;
    if (createdDelta !== 0) {
      return createdDelta;
    }
    const updatedDelta = b.updatedAt - a.updatedAt;
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return b.runtimeRunId.localeCompare(a.runtimeRunId);
  })[0];
  if (!parent) {
    return {
      status: "missing",
      reason: "no_open_parent_for_session",
      candidateCount: candidates.length,
    };
  }
  return {
    status: "linked",
    parent,
    reason: "newest_same_session_fallback",
    candidateCount: candidates.length,
  };
}

function normalizeSubagentTerminalStatus(status: string | undefined): string | undefined {
  return status?.trim().toLowerCase();
}

function mapOutcomeToLinkStatus(status: string | undefined): DurableRuntimeLinkStatus {
  switch (normalizeSubagentTerminalStatus(status)) {
    case "ok":
    case "success":
    case "succeeded":
    case "done":
    case "complete":
    case "completed":
      return "succeeded";
    case "canceled":
    case "cancelled":
    case "aborted":
    case "killed":
      return "cancelled";
    case "lost":
    case "timed_out":
    case "timeout":
      return "lost";
    default:
      return "failed";
  }
}

function isTerminalRunStatus(status: DurableRuntimeRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function isTerminalLinkStatus(status: DurableRuntimeLinkStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function isParentFanInComplete(params: {
  store: DurableRuntimeStore;
  parentRuntimeRunId: string;
}): boolean {
  const childLinks = params.store.listChildLinks(params.parentRuntimeRunId);
  return childLinks.length > 0 && childLinks.every((link) => isTerminalLinkStatus(link.status));
}

function findRunByIdempotencyKey(params: {
  store: DurableRuntimeStore;
  operationKind: string;
  idempotencyKey: string | undefined;
}): DurableRuntimeRun | undefined {
  const idempotencyKey = params.idempotencyKey?.trim();
  if (!idempotencyKey) {
    return undefined;
  }
  return params.store
    .listRuns({ limit: 5000 })
    .find(
      (run) => run.operationKind === params.operationKind && run.idempotencyKey === idempotencyKey,
    );
}

export function recordDurableSubagentRegistered(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  taskId?: string;
  taskFlowId?: string;
  task?: string;
  taskName?: string;
  label?: string;
  agentId?: string;
  requesterAgentId?: string;
  requesterRunId?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (!isDurableRuntimesEnabled(env)) {
    return;
  }
  safeCall(() => {
    const now = Date.now();
    const store = openDurableRuntimeStore({ env });
    try {
      const parentBinding = findOpenParentRun({
        store,
        requesterSessionKey: params.requesterSessionKey,
        requesterRunId: params.requesterRunId,
      });
      const parent = parentBinding.status === "linked" ? parentBinding.parent : undefined;
      const metadata = {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        runId: params.runId,
        taskId: params.taskId,
        taskFlowId: params.taskFlowId,
        taskHash: hashOptional(params.task),
        taskName: boundedText(params.taskName, 120),
        label: boundedText(params.label, 120),
        agentId: params.agentId,
        requesterAgentId: params.requesterAgentId,
        requesterRunId: params.requesterRunId,
        parentBinding: {
          status: parentBinding.status,
          reason: parentBinding.reason,
          candidateCount: parentBinding.candidateCount,
          ...(parent ? { parentRuntimeRunId: parent.runtimeRunId } : {}),
        },
      };
      const child = store.createRun({
        operationKind: DURABLE_SUBAGENT_RUN_OPERATION_KIND,
        operationVersion: "1",
        status: "running",
        recoveryState: "running",
        idempotencyKey: params.runId,
        requestHash: sha256(`${params.runId}:${params.childSessionKey}`),
        sourceType: "subagent",
        sourceRef: params.childSessionKey,
        parentRuntimeRunId: parent?.runtimeRunId,
        parentStepId: parent ? SUBAGENT_PARENT_STEP_ID : undefined,
        metadata,
        now,
      });
      store.createStep({
        runtimeRunId: child.runtimeRunId,
        stepId: "subagent_run",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        idempotencyKey: params.runId,
        metadata,
        now,
      });
      store.appendEvent({
        runtimeRunId: child.runtimeRunId,
        eventType: "subagent.run.started",
        eventTime: now,
        stepId: "subagent_run",
        agentInvocationId: params.runId,
        idempotencyKey: params.runId,
        correlationId: params.requesterSessionKey,
        payload: metadata,
      });
      if (!parent) {
        store.appendEvent({
          runtimeRunId: child.runtimeRunId,
          eventType: "subagent.parent.binding_missing",
          eventTime: now,
          stepId: "subagent_run",
          agentInvocationId: params.runId,
          idempotencyKey: `${params.runId}:parent-binding:${parentBinding.reason}`,
          correlationId: params.requesterSessionKey,
          payload: {
            requesterSessionKey: params.requesterSessionKey,
            requesterRunId: params.requesterRunId,
            reason: parentBinding.reason,
            candidateCount: parentBinding.candidateCount,
          },
        });
        recordDurableWakeForSubagentParentBindingMissing({
          store,
          childRun: child,
          requesterSessionKey: params.requesterSessionKey,
          requesterRunId: params.requesterRunId,
          reason: parentBinding.reason,
          candidateCount: parentBinding.candidateCount,
          now,
        });
        return;
      }
      const fanInGroupId = buildDurableFanInGroupId({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: SUBAGENT_PARENT_STEP_ID,
      });
      store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: SUBAGENT_PARENT_STEP_ID,
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        idempotencyKey: `${parent.runtimeRunId}:${SUBAGENT_PARENT_STEP_ID}`,
        metadata: {
          policy: "continue_on_child_failure" satisfies DurableFanInPolicy,
          fanInGroupId,
        },
        now,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: SUBAGENT_PARENT_STEP_ID,
        childRuntimeRunId: child.runtimeRunId,
        linkType: "subagent",
        status: "running",
        metadata: {
          ...metadata,
          fanInGroupId,
        },
        now,
      });
      store.appendEvent({
        runtimeRunId: parent.runtimeRunId,
        eventType: "subagent.child.linked",
        eventTime: now,
        stepId: SUBAGENT_PARENT_STEP_ID,
        agentInvocationId: params.runId,
        correlationId: params.childSessionKey,
        payload: {
          childRuntimeRunId: child.runtimeRunId,
          fanInGroupId,
          ...metadata,
        },
      });
      reconcileDurableFanIn({
        store,
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: SUBAGENT_PARENT_STEP_ID,
        policy: "continue_on_child_failure",
        now,
      });
    } finally {
      store.close();
    }
  });
}

export function recordDurableSubagentTerminal(params: {
  runId: string;
  childSessionKey?: string;
  status?: string;
  error?: string;
  summary?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (!isDurableRuntimesEnabled(env)) {
    return;
  }
  safeCall(() => {
    const now = Date.now();
    const store = openDurableRuntimeStore({ env });
    try {
      const child = store.createRun({
        operationKind: DURABLE_SUBAGENT_RUN_OPERATION_KIND,
        operationVersion: "1",
        status: "running",
        recoveryState: "running",
        idempotencyKey: params.runId,
        requestHash: params.childSessionKey
          ? sha256(`${params.runId}:${params.childSessionKey}`)
          : undefined,
        sourceType: "subagent",
        sourceRef: params.childSessionKey,
        metadata: {
          childSessionKey: params.childSessionKey,
        },
        now,
      });
      const linkStatus = mapOutcomeToLinkStatus(params.status);
      const existingMetadata =
        child.metadata && typeof child.metadata === "object" && !Array.isArray(child.metadata)
          ? child.metadata
          : {};
      const runStatus =
        linkStatus === "succeeded"
          ? "succeeded"
          : linkStatus === "cancelled"
            ? "cancelled"
            : linkStatus === "lost"
              ? "lost"
              : "failed";
      store.updateRun({
        runtimeRunId: child.runtimeRunId,
        status: runStatus,
        recoveryState: runStatus === "lost" ? "lost" : "terminal",
        completedAt: now,
        metadata: {
          ...existingMetadata,
          childSessionKey: params.childSessionKey,
          status: params.status,
          error: params.error,
          summary: params.summary,
        },
        now,
      });
      store.updateStep({
        runtimeRunId: child.runtimeRunId,
        stepId: "subagent_run",
        status:
          runStatus === "succeeded"
            ? "succeeded"
            : runStatus === "cancelled"
              ? "cancelled"
              : runStatus === "lost"
                ? "lost"
                : "failed",
        recoveryState: runStatus === "lost" ? "lost" : "terminal",
        completedAt: now,
        metadata: {
          ...existingMetadata,
          childSessionKey: params.childSessionKey,
          status: params.status,
          error: params.error,
          summary: params.summary,
        },
        now,
      });
      store.appendEvent({
        runtimeRunId: child.runtimeRunId,
        eventType: "subagent.run.terminal",
        eventTime: now,
        stepId: "subagent_run",
        agentInvocationId: params.runId,
        idempotencyKey: `${params.runId}:terminal`,
        correlationId: params.childSessionKey,
        payload: {
          status: params.status,
          error: params.error,
          summary: params.summary,
        },
      });
      for (const link of store.listParentLinks(child.runtimeRunId)) {
        const parent = store.getRun(link.parentRuntimeRunId);
        const linkMetadata =
          link.metadata && typeof link.metadata === "object" && !Array.isArray(link.metadata)
            ? link.metadata
            : {};
        store.updateLink({
          parentRuntimeRunId: link.parentRuntimeRunId,
          parentStepId: link.parentStepId,
          childRuntimeRunId: link.childRuntimeRunId,
          status: linkStatus,
          metadata: {
            ...linkMetadata,
            childSessionKey: params.childSessionKey,
            status: params.status,
            error: params.error,
            summary: params.summary,
          },
          now,
        });
        store.appendEvent({
          runtimeRunId: link.parentRuntimeRunId,
          eventType: "subagent.child.terminal",
          eventTime: now,
          stepId: link.parentStepId,
          agentInvocationId: params.runId,
          correlationId: params.childSessionKey,
          payload: {
            childRuntimeRunId: child.runtimeRunId,
            status: linkStatus,
            error: params.error,
            summary: params.summary,
          },
        });
        const mailbox = upsertDurableChildResultMailbox({
          store,
          parentRuntimeRunId: link.parentRuntimeRunId,
          parentStepId: link.parentStepId,
          childRuntimeRunId: child.runtimeRunId,
          childSessionKey: params.childSessionKey,
          agentInvocationId: params.runId,
          linkStatus,
          terminalStatus: params.status,
          terminalOutcome: linkStatus,
          error: params.error,
          summary: params.summary,
          now,
        });
        if (!isDurableResultMailboxAcknowledged(mailbox)) {
          store.appendEvent({
            runtimeRunId: link.parentRuntimeRunId,
            eventType: "subagent.child.result_mailbox_queued",
            eventTime: now,
            stepId: link.parentStepId,
            agentInvocationId: params.runId,
            correlationId: params.childSessionKey,
            payload: {
              childRuntimeRunId: child.runtimeRunId,
              status: linkStatus,
              error: params.error,
              summary: params.summary,
            },
          });
        }
        if (parent) {
          recordDurableWakeForChildTerminalFact({
            store,
            parentRun: parent,
            childRun: child,
            link,
            terminalOutcome: linkStatus,
            childSessionKey: params.childSessionKey,
            agentInvocationId: params.runId,
            error: params.error,
            summary: params.summary,
            now,
          });
        }
        reconcileDurableFanIn({
          store,
          parentRuntimeRunId: link.parentRuntimeRunId,
          parentStepId: link.parentStepId,
          policy: "continue_on_child_failure",
          now,
        });
      }
    } finally {
      store.close();
    }
  });
}

export function recordDurableSubagentProgress(params: {
  runId: string;
  childSessionKey?: string;
  status?: "running" | "waiting";
  reason?: string;
  detail?: string;
  elapsedMs?: number;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (!isDurableRuntimesEnabled(env)) {
    return;
  }
  safeCall(() => {
    const now = Date.now();
    const store = openDurableRuntimeStore({ env });
    try {
      const child = store.createRun({
        operationKind: DURABLE_SUBAGENT_RUN_OPERATION_KIND,
        operationVersion: "1",
        status: "running",
        recoveryState: "running",
        idempotencyKey: params.runId,
        requestHash: params.childSessionKey
          ? sha256(`${params.runId}:${params.childSessionKey}`)
          : undefined,
        sourceType: "subagent",
        sourceRef: params.childSessionKey,
        metadata: {
          childSessionKey: params.childSessionKey,
        },
        now,
      });
      const existingMetadata =
        child.metadata && typeof child.metadata === "object" && !Array.isArray(child.metadata)
          ? child.metadata
          : {};
      const progress = {
        status: params.status ?? "running",
        reason: params.reason,
        detail: boundedText(params.detail, 240),
        elapsedMs: params.elapsedMs,
        observedAt: now,
      };
      const metadata = {
        ...existingMetadata,
        childSessionKey: params.childSessionKey,
        lastProgress: progress,
      };
      store.updateRun({
        runtimeRunId: child.runtimeRunId,
        status: "running",
        recoveryState: "running",
        metadata,
        now,
      });
      store.createStep({
        runtimeRunId: child.runtimeRunId,
        stepId: "subagent_run",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        idempotencyKey: params.runId,
        metadata,
        now,
      });
      store.appendEvent({
        runtimeRunId: child.runtimeRunId,
        eventType: "subagent.run.progress",
        eventTime: now,
        stepId: "subagent_run",
        agentInvocationId: params.runId,
        idempotencyKey: `${params.runId}:progress:${now}`,
        correlationId: params.childSessionKey,
        payload: progress,
      });
      for (const link of store.listParentLinks(child.runtimeRunId)) {
        const linkMetadata =
          link.metadata && typeof link.metadata === "object" && !Array.isArray(link.metadata)
            ? link.metadata
            : {};
        const payload = {
          childRuntimeRunId: child.runtimeRunId,
          childSessionKey: params.childSessionKey,
          ...progress,
        };
        store.updateLink({
          parentRuntimeRunId: link.parentRuntimeRunId,
          parentStepId: link.parentStepId,
          childRuntimeRunId: link.childRuntimeRunId,
          status: "running",
          metadata: {
            ...linkMetadata,
            lastProgress: progress,
          },
          now,
        });
        store.appendEvent({
          runtimeRunId: link.parentRuntimeRunId,
          eventType: "subagent.child.progress",
          eventTime: now,
          stepId: link.parentStepId,
          agentInvocationId: params.runId,
          correlationId: params.childSessionKey,
          payload,
        });
      }
    } finally {
      store.close();
    }
  });
}

export function recordDurableSubagentAnnounceDelivery(params: {
  runId: string;
  childSessionKey?: string;
  directIdempotencyKey?: string;
  delivered: boolean;
  path?: string;
  error?: string;
  reason?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (!isDurableRuntimesEnabled(env)) {
    return;
  }
  safeCall(() => {
    const now = Date.now();
    const store = openDurableRuntimeStore({ env });
    try {
      const child = findRunByIdempotencyKey({
        store,
        operationKind: DURABLE_SUBAGENT_RUN_OPERATION_KIND,
        idempotencyKey: params.runId,
      });
      if (!child) {
        return;
      }
      const directRun = findRunByIdempotencyKey({
        store,
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        idempotencyKey: params.directIdempotencyKey,
      });
      for (const link of store.listParentLinks(child.runtimeRunId)) {
        const deliveryAcknowledged =
          params.delivered &&
          params.path === "direct" &&
          directRun?.status === "succeeded" &&
          directRun.recoveryState === "terminal";
        const payload = {
          childRuntimeRunId: child.runtimeRunId,
          childSessionKey: params.childSessionKey,
          directRuntimeRunId: directRun?.runtimeRunId,
          directIdempotencyKey: params.directIdempotencyKey,
          delivered: params.delivered,
          acknowledged: deliveryAcknowledged,
          path: params.path,
          error: params.error,
          reason: params.reason,
        };
        store.appendEvent({
          runtimeRunId: link.parentRuntimeRunId,
          eventType: params.delivered
            ? "subagent.child.announce_delivered"
            : "subagent.child.announce_delivery_failed",
          eventTime: now,
          stepId: link.parentStepId,
          agentInvocationId: params.runId,
          correlationId: params.childSessionKey,
          payload,
        });
        recordDurableResultMailboxDeliveryAttempt({
          store,
          parentRuntimeRunId: link.parentRuntimeRunId,
          parentStepId: link.parentStepId,
          childRuntimeRunId: child.runtimeRunId,
          childSessionKey: params.childSessionKey,
          agentInvocationId: params.runId,
          directRuntimeRunId: directRun?.runtimeRunId,
          directIdempotencyKey: params.directIdempotencyKey,
          delivered: params.delivered,
          acknowledged: deliveryAcknowledged,
          path: params.path,
          error: params.error,
          reason: params.reason,
          now,
        });
        const parent = store.getRun(link.parentRuntimeRunId);
        if (!params.delivered && parent) {
          recordDurableWakeForDeliveryUnknownFact({
            store,
            parentRun: parent,
            childRun: child,
            link,
            childSessionKey: params.childSessionKey,
            agentInvocationId: params.runId,
            path: params.path,
            error: params.error,
            deliveryReason: params.reason,
            directRuntimeRunId: directRun?.runtimeRunId,
            directIdempotencyKey: params.directIdempotencyKey,
            now,
          });
        }
        if (!parent || isTerminalRunStatus(parent.status)) {
          continue;
        }
        const parentMetadata =
          parent.metadata && typeof parent.metadata === "object" && !Array.isArray(parent.metadata)
            ? parent.metadata
            : {};
        const metadata = {
          ...parentMetadata,
          lastSubagentAnnounceDelivery: payload,
        };
        if (
          params.delivered &&
          params.path === "direct" &&
          directRun?.status === "succeeded" &&
          directRun.recoveryState === "terminal" &&
          deliveryAcknowledged &&
          isParentFanInComplete({ store, parentRuntimeRunId: parent.runtimeRunId })
        ) {
          const parentStep = store
            .listSteps(parent.runtimeRunId)
            .find((step) => step.stepId === link.parentStepId);
          const parentStepMetadata =
            parentStep?.metadata &&
            typeof parentStep.metadata === "object" &&
            !Array.isArray(parentStep.metadata)
              ? parentStep.metadata
              : {};
          store.updateStep({
            runtimeRunId: parent.runtimeRunId,
            stepId: link.parentStepId,
            status: "succeeded",
            recoveryState: "terminal",
            completedAt: now,
            metadata: {
              ...parentStepMetadata,
              lastSubagentAnnounceDelivery: payload,
            },
            now,
          });
          store.updateRun({
            runtimeRunId: parent.runtimeRunId,
            status: "succeeded",
            recoveryState: "terminal",
            completedAt: now,
            metadata,
            now,
          });
          store.updateStep({
            runtimeRunId: parent.runtimeRunId,
            stepId: "agent_invocation",
            status: "succeeded",
            recoveryState: "terminal",
            completedAt: now,
            metadata,
            now,
          });
          store.appendEvent({
            runtimeRunId: parent.runtimeRunId,
            eventType: "agent.turn.continuation_succeeded",
            eventTime: now,
            stepId: "agent_invocation",
            agentInvocationId: params.directIdempotencyKey,
            correlationId: params.childSessionKey,
            payload,
          });
          continue;
        }
        store.updateRun({
          runtimeRunId: parent.runtimeRunId,
          metadata,
          now,
        });
      }
    } finally {
      store.close();
    }
  });
}
