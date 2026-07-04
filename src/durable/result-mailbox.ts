import type { DurableRuntimeStep, DurableRuntimeStore, DurableRuntimeLinkStatus } from "./types.js";

export const DURABLE_RESULT_MAILBOX_IDEMPOTENCY_PREFIX = "result-mailbox:v1:";

export function buildDurableChildResultMailboxStepId(childRuntimeRunId: string): string {
  return `result_mailbox:${childRuntimeRunId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stepMetadata(step: DurableRuntimeStep | undefined): Record<string, unknown> {
  return isRecord(step?.metadata) ? step.metadata : {};
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isDurableResultMailboxAcknowledged(step: DurableRuntimeStep | undefined): boolean {
  const metadata = stepMetadata(step);
  const ack = isRecord(metadata.ack) ? metadata.ack : {};
  return (
    step?.status === "succeeded" &&
    step.recoveryState === "terminal" &&
    ack.status === "acknowledged"
  );
}

function durableResultMailboxIdempotencyKey(params: {
  parentRuntimeRunId: string;
  parentStepId: string;
  childRuntimeRunId: string;
}): string {
  return [
    DURABLE_RESULT_MAILBOX_IDEMPOTENCY_PREFIX,
    params.parentRuntimeRunId,
    ":",
    params.parentStepId,
    ":",
    params.childRuntimeRunId,
  ].join("");
}

function findDurableChildResultMailbox(params: {
  store: DurableRuntimeStore;
  parentRuntimeRunId: string;
  childRuntimeRunId: string;
}): DurableRuntimeStep | undefined {
  const stepId = buildDurableChildResultMailboxStepId(params.childRuntimeRunId);
  return params.store
    .listSteps(params.parentRuntimeRunId)
    .find((step) => step.stepId === stepId && step.stepType === "result_mailbox");
}

export function upsertDurableChildResultMailbox(params: {
  store: DurableRuntimeStore;
  parentRuntimeRunId: string;
  parentStepId: string;
  childRuntimeRunId: string;
  childSessionKey?: string;
  agentInvocationId?: string;
  linkStatus: DurableRuntimeLinkStatus;
  terminalStatus?: string;
  terminalOutcome?: string;
  error?: string;
  summary?: string;
  reason?: string;
  now?: number;
}): DurableRuntimeStep {
  const now = params.now ?? Date.now();
  const stepId = buildDurableChildResultMailboxStepId(params.childRuntimeRunId);
  const idempotencyKey = durableResultMailboxIdempotencyKey(params);
  const mailbox = params.store.createStep({
    runtimeRunId: params.parentRuntimeRunId,
    stepId,
    parentStepId: params.parentStepId,
    stepType: "result_mailbox",
    status: "queued",
    recoveryState: "runnable",
    idempotencyKey,
    metadata: {
      kind: "child_result_mailbox",
      status: "pending_parent_ack",
      parentRuntimeRunId: params.parentRuntimeRunId,
      parentStepId: params.parentStepId,
      childRuntimeRunId: params.childRuntimeRunId,
      childSessionKey: params.childSessionKey,
      agentInvocationId: params.agentInvocationId,
      outcome: {
        linkStatus: params.linkStatus,
        terminalStatus: params.terminalStatus,
        terminalOutcome: params.terminalOutcome ?? params.linkStatus,
        error: params.error,
        summary: params.summary,
        reason: params.reason,
      },
      ack: {
        status: "pending",
      },
      receivedAt: now,
      updatedAt: now,
    },
    now,
  });
  if (isDurableResultMailboxAcknowledged(mailbox)) {
    return mailbox;
  }

  const existingMetadata = stepMetadata(mailbox);
  const existingDelivery = isRecord(existingMetadata.delivery)
    ? { delivery: existingMetadata.delivery }
    : {};
  return (
    params.store.updateStep({
      runtimeRunId: params.parentRuntimeRunId,
      stepId,
      status: "queued",
      recoveryState: "runnable",
      completedAt: null,
      metadata: {
        ...existingMetadata,
        ...existingDelivery,
        kind: "child_result_mailbox",
        status: "pending_parent_ack",
        parentRuntimeRunId: params.parentRuntimeRunId,
        parentStepId: params.parentStepId,
        childRuntimeRunId: params.childRuntimeRunId,
        childSessionKey: params.childSessionKey,
        agentInvocationId: params.agentInvocationId,
        outcome: {
          linkStatus: params.linkStatus,
          terminalStatus: params.terminalStatus,
          terminalOutcome: params.terminalOutcome ?? params.linkStatus,
          error: params.error,
          summary: params.summary,
          reason: params.reason,
        },
        ack: isRecord(existingMetadata.ack) ? existingMetadata.ack : { status: "pending" },
        receivedAt: numberFrom(existingMetadata.receivedAt) ?? now,
        updatedAt: now,
      },
      now,
    }) ?? mailbox
  );
}

export function recordDurableResultMailboxDeliveryAttempt(params: {
  store: DurableRuntimeStore;
  parentRuntimeRunId: string;
  parentStepId: string;
  childRuntimeRunId: string;
  childSessionKey?: string;
  agentInvocationId?: string;
  directRuntimeRunId?: string;
  directIdempotencyKey?: string;
  delivered: boolean;
  acknowledged: boolean;
  path?: string;
  error?: string;
  reason?: string;
  now?: number;
}): DurableRuntimeStep {
  const now = params.now ?? Date.now();
  const mailbox =
    findDurableChildResultMailbox({
      store: params.store,
      parentRuntimeRunId: params.parentRuntimeRunId,
      childRuntimeRunId: params.childRuntimeRunId,
    }) ??
    upsertDurableChildResultMailbox({
      store: params.store,
      parentRuntimeRunId: params.parentRuntimeRunId,
      parentStepId: params.parentStepId,
      childRuntimeRunId: params.childRuntimeRunId,
      childSessionKey: params.childSessionKey,
      agentInvocationId: params.agentInvocationId,
      linkStatus: "succeeded",
      terminalOutcome: "succeeded",
      now,
    });
  const metadata = stepMetadata(mailbox);
  if (isDurableResultMailboxAcknowledged(mailbox)) {
    return mailbox;
  }
  const previousDelivery = isRecord(metadata.delivery) ? metadata.delivery : {};
  const attempts = (numberFrom(previousDelivery.attempts) ?? 0) + 1;
  const deliveryStatus = params.acknowledged
    ? "acknowledged"
    : params.delivered
      ? "attempted"
      : "failed";
  const delivery = {
    status: deliveryStatus,
    delivered: params.delivered,
    acknowledged: params.acknowledged,
    path: params.path,
    directRuntimeRunId: params.directRuntimeRunId,
    directIdempotencyKey: params.directIdempotencyKey,
    error: params.error,
    reason: params.reason,
    attempts,
    lastAttemptAt: now,
  };
  const ack = params.acknowledged
    ? {
        status: "acknowledged",
        consumerRuntimeRunId: params.directRuntimeRunId,
        directIdempotencyKey: params.directIdempotencyKey,
        consumedAt: now,
      }
    : {
        ...(isRecord(metadata.ack) ? metadata.ack : {}),
        status: "pending",
      };
  const step = params.store.updateStep({
    runtimeRunId: params.parentRuntimeRunId,
    stepId: mailbox.stepId,
    status: params.acknowledged ? "succeeded" : "queued",
    recoveryState: params.acknowledged ? "terminal" : "runnable",
    completedAt: params.acknowledged ? now : null,
    metadata: {
      ...metadata,
      status: params.acknowledged ? "acknowledged" : "pending_parent_ack",
      delivery,
      ack,
      updatedAt: now,
    },
    now,
  });
  const updated = step ?? mailbox;
  params.store.appendEvent({
    runtimeRunId: params.parentRuntimeRunId,
    eventType: params.acknowledged
      ? "result_mailbox.consumed"
      : params.delivered
        ? "result_mailbox.delivery_attempted"
        : "result_mailbox.delivery_failed",
    eventTime: now,
    stepId: mailbox.stepId,
    agentInvocationId: params.agentInvocationId,
    correlationId: params.childSessionKey,
    payload: {
      childRuntimeRunId: params.childRuntimeRunId,
      childSessionKey: params.childSessionKey,
      directRuntimeRunId: params.directRuntimeRunId,
      directIdempotencyKey: params.directIdempotencyKey,
      delivered: params.delivered,
      acknowledged: params.acknowledged,
      path: params.path,
      error: params.error,
      reason: params.reason,
      attempts,
    },
  });
  return updated;
}
