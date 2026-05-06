import { emitContinuationFanoutSpan } from "../../infra/continuation-tracer.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import {
  ackSessionDelivery,
  enqueueSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import type { SessionDeliveryContext } from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasContinuationDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting-pure.js";
import type {
  ContinuationDelegateFanoutMode,
  ContinuationDelegateTargeting,
} from "./targeting-pure.js";

export {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasContinuationDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
};
export type { ContinuationDelegateFanoutMode, ContinuationDelegateTargeting };

export function resolveContinuationReturnTargetSessionKeys(
  params: ContinuationDelegateTargeting & {
    defaultSessionKey: string;
    treeSessionKeys?: readonly string[];
    allSessionKeys?: readonly string[];
    childSessionKey?: string;
  },
): string[] {
  const defaultSessionKey = normalizeContinuationTargetKey(params.defaultSessionKey);
  const fallback = defaultSessionKey ? [defaultSessionKey] : [];

  if (params.fanoutMode === "tree") {
    const treeKeys = normalizeContinuationTargetKeys(params.treeSessionKeys);
    return treeKeys.length > 0 ? treeKeys : fallback;
  }

  if (params.fanoutMode === "all") {
    const childSessionKey = normalizeContinuationTargetKey(params.childSessionKey);
    const allKeys = normalizeContinuationTargetKeys(params.allSessionKeys).filter(
      (sessionKey) => sessionKey !== childSessionKey,
    );
    return allKeys.length > 0 ? allKeys : fallback;
  }

  const explicitKeys = normalizeContinuationTargetKeys([
    ...(params.targetSessionKey ? [params.targetSessionKey] : []),
    ...(params.targetSessionKeys ?? []),
  ]);
  return explicitKeys.length > 0 ? explicitKeys : fallback;
}

type ContinuationReturnDeliveryDeps = {
  enqueueSessionDelivery: typeof enqueueSessionDelivery;
  ackSessionDelivery: typeof ackSessionDelivery;
  enqueueSystemEvent: typeof enqueueSystemEvent;
  requestHeartbeatNow: typeof requestHeartbeatNow;
};

const defaultContinuationReturnDeliveryDeps: ContinuationReturnDeliveryDeps = {
  enqueueSessionDelivery,
  ackSessionDelivery,
  enqueueSystemEvent,
  requestHeartbeatNow,
};

export async function enqueueContinuationReturnDeliveries(
  params: {
    targetSessionKeys: readonly string[];
    text: string;
    idempotencyKeyBase: string;
    deliveryContext?: SessionDeliveryContext;
    wakeRecipients?: boolean;
    childRunId?: string;
    stateDir?: string;
    traceparent?: string;
    fanoutMode?: ContinuationDelegateFanoutMode;
    chainStepRemaining?: number;
  },
  deps: ContinuationReturnDeliveryDeps = defaultContinuationReturnDeliveryDeps,
): Promise<{ enqueued: number; delivered: number; deliveryIds: string[] }> {
  const targetSessionKeys = normalizeContinuationTargetKeys(params.targetSessionKeys);
  const deliveryIds: string[] = [];
  let delivered = 0;

  for (const [index, sessionKey] of targetSessionKeys.entries()) {
    const deliveryId = await deps.enqueueSessionDelivery(
      {
        kind: "systemEvent",
        sessionKey,
        text: params.text,
        ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
        ...(params.traceparent ? { traceparent: params.traceparent } : {}),
        idempotencyKey: `${params.idempotencyKeyBase}:${index}:${sessionKey}`,
      },
      params.stateDir,
    );
    deliveryIds.push(deliveryId);

    deps.enqueueSystemEvent(params.text, {
      sessionKey,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
    });
    if (params.wakeRecipients) {
      deps.requestHeartbeatNow({
        sessionKey,
        reason: "delegate-return",
        parentRunId: params.childRunId,
      });
    }
    // Do NOT ack the durable file here. enqueueSystemEvent above is in-memory
    // (process-local globalThis Map) — non-attached recipients (different
    // process / restart-pending) cannot see it. The durable file must persist
    // until recipient consumption so the recovery loop can replay on next
    // gateway restart. Durable writes are expected for non-attached recipients
    // per RFC §2.4; acking immediately would destroy the only durable channel
    // and leave targeted recipients silently unreached.
    delivered += 1;
  }

  if (
    (params.traceparent !== undefined || params.chainStepRemaining !== undefined) &&
    (params.fanoutMode !== undefined || targetSessionKeys.length > 1)
  ) {
    emitContinuationFanoutSpan({
      targetSessionKeys,
      deliveredCount: delivered,
      ...(params.fanoutMode ? { fanoutMode: params.fanoutMode } : {}),
      ...(params.chainStepRemaining !== undefined
        ? { chainStepRemaining: params.chainStepRemaining }
        : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
    });
  }

  return {
    enqueued: deliveryIds.length,
    delivered,
    deliveryIds,
  };
}
