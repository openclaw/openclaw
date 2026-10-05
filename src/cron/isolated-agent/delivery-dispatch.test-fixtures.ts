import { vi } from "vitest";
import * as deliveryQueueStorage from "../../infra/outbound/delivery-queue-storage.js";
import type { QueuedDelivery } from "../../infra/outbound/delivery-queue-types.js";
import { createUnmodifiedPreparedOutboundBatch } from "../../infra/outbound/prepared-batch.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronDelivery } from "../types.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";

type SuccessfulDeliveryResolution = Extract<DeliveryTargetResolution, { ok: true }>;

export function makeResolvedDelivery(
  overrides: Partial<SuccessfulDeliveryResolution> = {},
): SuccessfulDeliveryResolution {
  return {
    ok: true,
    channel: "telegram",
    to: "123456",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    ...overrides,
  };
}

export function makeBaseParams(overrides: {
  synthesizedText?: string;
  deliveryRequested?: boolean;
  runStartedAt?: number;
  sessionTarget?: string;
  deliveryBestEffort?: boolean;
  spawnOnlyHandoff?: boolean;
  runSessionKey?: string;
  resolvedDeliveryMode?: "explicit" | "implicit";
}): DispatchCronDeliveryParams {
  const resolvedDelivery = {
    ...makeResolvedDelivery(),
    mode: overrides.resolvedDeliveryMode ?? "explicit",
  } satisfies Extract<DeliveryTargetResolution, { ok: true }>;
  const delivery: CronDelivery = {
    mode: "announce",
    bestEffort: overrides.deliveryBestEffort,
  };
  const runStartedAt = overrides.runStartedAt ?? Date.now();
  return {
    deliveryAttemptFence: null,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      sessionTarget: overrides.sessionTarget ?? "isolated",
      sessionKey:
        overrides.sessionTarget === "current" ? "agent:main:webchat:direct:owner" : undefined,
      deleteAfterRun: false,
      delivery,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main:cron:test-job",
    sourceSessionKey:
      overrides.sessionTarget === "current" ? "agent:main:webchat:direct:owner" : undefined,
    sourceSessionGeneration:
      overrides.sessionTarget === "current"
        ? { sessionId: "source-session-id", lifecycleRevision: "source-lifecycle-revision" }
        : undefined,
    runSessionKey: overrides.runSessionKey ?? "agent:main:cron:test-job",
    sessionId: "test-session-id",
    lifecycleRevision: "test-lifecycle-revision",
    sessionUpdatedAt: 1_000,
    runStartedAt,
    timeoutMs: 30_000,
    resolvedDelivery,
    deliveryPlan: resolveCronDeliveryPlan({ delivery }),
    deliveryRequested: overrides.deliveryRequested ?? true,
    undeliveredRunStatus: "ok",
    skipDelivery: undefined,
    spawnOnlyHandoff: overrides.spawnOnlyHandoff ?? false,
    sourceDeliveryOutcome: {
      visibleDeliveries: [],
      verifiedMessageToolDelivery: false,
      satisfiesSourceDelivery: false,
      unverifiedMessageToolDelivery: false,
    },
    deliveryBestEffort: overrides.deliveryBestEffort ?? false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : [],
    synthesizedText: overrides.synthesizedText ?? "on it",
    summary: overrides.synthesizedText ?? "on it",
    outputText: overrides.synthesizedText ?? "on it",
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
  };
}

const pendingIntentOwner = {
  queueName: "outbound-prepared-v1",
  namespace: "prepared",
  retired: false,
  status: "pending",
} as const;

/** Answers the next queue custody reads of a cron delivery intent, in order; null is no custody. */
export function mockIntentCustody(...statuses: Array<"pending" | "completed" | null>) {
  const read = vi.mocked(deliveryQueueStorage.findDeliveryIntentOwner);
  for (const status of statuses) {
    read.mockResolvedValueOnce(status && { ...pendingIntentOwner, status });
  }
}

/** A cross-process producer that started its platform send at `platformSendStartedAt`. */
export function sendingCronIntent(id: string, platformSendStartedAt: number): QueuedDelivery {
  return {
    id,
    channel: "telegram",
    to: "123456",
    preparedBatch: createUnmodifiedPreparedOutboundBatch([{ text: "cron update" }]),
    enqueuedAt: platformSendStartedAt,
    retryCount: 0,
    attemptCount: 1,
    platformSendStartedAt,
    recoveryState: "send_attempt_started",
  };
}
