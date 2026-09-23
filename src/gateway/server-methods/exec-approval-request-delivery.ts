import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import { runApprovalRequestDeliveries } from "./approval-request-delivery.js";
import { buildRequestedApprovalEvent, handlePendingApprovalRequest } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

type PendingExecApproval = Pick<
  Parameters<typeof handlePendingApprovalRequest<ExecApprovalRequestPayload>>[0],
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
>;

/** All command approval producers share the same delivery routes and visibility checks. */
export function handlePendingExecApprovalRequest(
  params: PendingExecApproval & {
    forwardRequest: GatewayRequestContext["forwardExecApprovalRequest"];
    getIosPushDelivery: () => GatewayRequestContext["execApprovalIosPushDelivery"];
  },
): Promise<void> {
  const { forwardRequest, getIosPushDelivery, afterDecision, afterDecisionErrorLabel, ...pending } =
    params;
  const requestEvent = buildRequestedApprovalEvent(pending.record, "exec");
  const iosPushDelivery = getIosPushDelivery();
  const iosPushRequest = iosPushDelivery?.handleRequested?.bind(iosPushDelivery);
  return handlePendingApprovalRequest({
    ...pending,
    requestEventName: "exec.approval.requested",
    requestEvent,
    approvalKind: "exec",
    deliverRequest: () =>
      runApprovalRequestDeliveries({
        context: pending.context,
        record: pending.record,
        forward: forwardRequest
          ? [() => forwardRequest(requestEvent), "exec approvals: forward request failed"]
          : undefined,
        iosPush: iosPushRequest
          ? [
              (isTargetVisible) => iosPushRequest(requestEvent, { isTargetVisible }),
              "exec approvals: iOS push request failed",
            ]
          : undefined,
      }),
    afterDecision: async (decision) => {
      if (decision === null) {
        await getIosPushDelivery()?.handleExpired?.(requestEvent);
      }
      await afterDecision?.(decision, requestEvent);
    },
    afterDecisionErrorLabel: afterDecisionErrorLabel ?? "exec approvals: iOS push expire failed",
  });
}
