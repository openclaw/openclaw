// Approval request delivery fans out external routes while preserving the
// approval record's visibility boundary for mobile and browser push targets.
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { runWithRetainedGatewayRootWork } from "../../process/gateway-work-admission.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import {
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
  isApprovalRecordVisibleToClient,
} from "./approval-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type ApprovalRequestDeliveryTarget = {
  deviceId: string;
  scopes: readonly string[];
};

type ApprovalPayloadByKind = {
  exec: ExecApprovalRequestPayload;
  plugin: PluginApprovalRequestPayload;
};
type PendingApproval<TKind extends keyof ApprovalPayloadByKind> = Parameters<
  typeof handlePendingApprovalRequest<ApprovalPayloadByKind[TKind]>
>[0];
type RequestedApproval<TKind extends keyof ApprovalPayloadByKind> = ReturnType<
  typeof buildRequestedApprovalEvent<ApprovalPayloadByKind[TKind], TKind>
>;

/** Request producers share delivery and expiry handling while retaining their typed payloads. */
export function handlePendingApprovalRequestWithDelivery<TKind extends keyof ApprovalPayloadByKind>(
  params: Pick<
    PendingApproval<TKind>,
    | "manager"
    | "record"
    | "respond"
    | "context"
    | "clientConnId"
    | "twoPhase"
    | "requireDeliveryRoute"
    | "suppressDelivery"
    | "deliverToApprovalClientsOnly"
    | "afterDecision"
    | "afterDecisionErrorLabel"
  > & {
    approvalKind: TKind;
    source?: "rpc" | "node-policy";
    forwardRequest?: (event: RequestedApproval<TKind>) => Promise<boolean>;
    getIosPushDelivery: () =>
      | {
          handleRequested?: (
            event: RequestedApproval<TKind>,
            options?: { isTargetVisible?: (target: ApprovalRequestDeliveryTarget) => boolean },
          ) => Promise<boolean>;
          handleExpired?: (event: RequestedApproval<TKind>) => Promise<void>;
        }
      | undefined;
  },
): Promise<void> {
  const {
    approvalKind,
    source,
    forwardRequest,
    getIosPushDelivery,
    afterDecision,
    afterDecisionErrorLabel,
    ...pending
  } = params;
  const requestEvent = buildRequestedApprovalEvent(pending.record, approvalKind);
  const iosPushDelivery = getIosPushDelivery();
  const iosPushRequest = iosPushDelivery?.handleRequested?.bind(iosPushDelivery);
  const logContext = source === "node-policy" ? "node policy " : "";
  const logPrefix = `${approvalKind} approvals:`;
  return handlePendingApprovalRequest({
    ...pending,
    approvalKind,
    requestEventName: `${approvalKind}.approval.requested`,
    requestEvent,
    deliverRequest: () =>
      runApprovalRequestDeliveries({
        context: pending.context,
        record: pending.record,
        forward: forwardRequest
          ? [() => forwardRequest(requestEvent), `${logPrefix} forward ${logContext}request failed`]
          : undefined,
        iosPush: iosPushRequest
          ? [
              (isTargetVisible) => iosPushRequest(requestEvent, { isTargetVisible }),
              `${logPrefix} iOS push ${logContext}request failed`,
            ]
          : undefined,
      }),
    afterDecision: async (decision) => {
      if (decision === null) {
        // Expiration uses the current delivery owner after the approval wait.
        await getIosPushDelivery()?.handleExpired?.(requestEvent);
      }
      await afterDecision?.(decision, requestEvent);
    },
    afterDecisionErrorLabel:
      afterDecisionErrorLabel ?? `${logPrefix} iOS push ${logContext}expire failed`,
  });
}

type ApprovalRequestDelivery = readonly [
  run: (isTargetVisible: (target: ApprovalRequestDeliveryTarget) => boolean) => Promise<boolean>,
  errorLabel: string,
];

type ApprovalDeliveryLogContext = {
  approvalWebPushDelivery?: Pick<
    NonNullable<GatewayRequestContext["approvalWebPushDelivery"]>,
    "handleRequested"
  >;
  logGateway?: { error?: (message: string) => void };
};

function trackApprovalDelivery<T>(run: () => Promise<T>): Promise<T> {
  return trackAsyncWork(() => runWithRetainedGatewayRootWork(run));
}

function resolveFirstSuccessfulApprovalDelivery(
  deliveryTasks: readonly Promise<boolean>[],
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let remaining = deliveryTasks.length;
    for (const delivery of deliveryTasks) {
      void delivery.then((delivered) => {
        if (delivered) {
          resolve(true);
          return;
        }
        remaining -= 1;
        if (remaining === 0) {
          resolve(false);
        }
      });
    }
  });
}

/** Runs external approval deliveries concurrently and reports whether any route accepted. */
function runApprovalRequestDeliveries<TPayload>(params: {
  context: ApprovalDeliveryLogContext;
  record: ExecApprovalRecord<TPayload>;
  forward?: ApprovalRequestDelivery;
  iosPush?: ApprovalRequestDelivery;
}): boolean | Promise<boolean> {
  const isTargetVisible = (target: ApprovalRequestDeliveryTarget) =>
    isApprovalRecordVisibleToClient({
      record: params.record,
      client: {
        connect: {
          client: { id: GATEWAY_CLIENT_IDS.IOS_APP },
          device: { id: target.deviceId },
          scopes: [...target.scopes],
        },
      } as GatewayClient,
    });
  const deliveryTasks = [params.forward, params.iosPush].flatMap((delivery) => {
    if (!delivery) {
      return [];
    }
    const [run, errorLabel] = delivery;
    return [
      trackApprovalDelivery(() => run(isTargetVisible)).catch((err: unknown) => {
        params.context.logGateway?.error?.(`${errorLabel}: ${String(err)}`);
        return false;
      }),
    ];
  });
  try {
    const webPushDelivery = params.context.approvalWebPushDelivery?.handleRequested(params.record);
    if (webPushDelivery !== false && webPushDelivery !== undefined) {
      deliveryTasks.push(
        trackApprovalDelivery(() => Promise.resolve(webPushDelivery)).catch((err: unknown) => {
          params.context.logGateway?.error?.(`approval Web Push request failed: ${String(err)}`);
          return false;
        }),
      );
    }
  } catch (err) {
    params.context.logGateway?.error?.(`approval Web Push request failed: ${String(err)}`);
  }
  if (deliveryTasks.length === 0) {
    return false;
  }
  // A delivered route must unblock approval while other started routes keep
  // their error handlers and can finish without delaying the requester.
  return resolveFirstSuccessfulApprovalDelivery(deliveryTasks);
}
