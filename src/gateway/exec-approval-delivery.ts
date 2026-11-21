import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { canResolveParticipationExecApproval } from "./exec-approval-participation.js";
import { canReviewOperatorApproval } from "./operator-approval-authorization.js";
import type { GatewayClient } from "./server-methods/types.js";

/** Subscription admission is not a grant: each replay/event checks its live approval binding. */
export function canSubscribeOperatorApprovals(client: GatewayClient | null): boolean {
  return Boolean(
    client &&
    !client.invalidated &&
    (client.connect.role ?? "operator") === "operator" &&
    (canReviewOperatorApproval(client) ||
      (client.authenticatedUserProfile?.profileId &&
        !client.internal?.agentRuntimeIdentity &&
        !client.internal?.approvalRuntime &&
        !client.internal?.syntheticClient)),
  );
}

/** Only an exact process-local manager binding can add creator delivery authority. */
export function participationExecApprovalRecipient(
  manager: Pick<ExecApprovalManager<unknown>, "getLiveSnapshot"> | undefined,
  id: string,
): ((client: GatewayClient) => boolean) | undefined {
  const record = manager?.getLiveSnapshot(id);
  if (!record?.participation) {
    return undefined;
  }
  return (client) =>
    manager?.getLiveSnapshot(id) === record &&
    canResolveParticipationExecApproval(record, client) === true;
}
