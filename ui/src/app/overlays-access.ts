import type { GatewayBrowserClient } from "../api/gateway.ts";
import { refreshPendingApprovalQueue, type ExecApprovalPromptState } from "./exec-approval.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";

export function readOverlayOperatorAccessTransition(
  previous: ReturnType<typeof readGatewayOperatorAccess>,
  snapshot: ApplicationGateway["snapshot"],
) {
  const access = snapshot.phase === "connected" ? readGatewayOperatorAccess(snapshot) : previous;
  return {
    access,
    reviewChanged: previous.canReviewApprovals !== access.canReviewApprovals,
    grantChanged: previous.canGrantApprovals !== access.canGrantApprovals,
    grantRevoked: previous.canGrantApprovals && !access.canGrantApprovals,
    adminRevoked: previous.canAdmin && !access.canAdmin,
    pairingChanged: previous.canPair !== access.canPair,
  };
}

export function createOverlayApprovalRefresher(params: {
  gateway: ApplicationGateway;
  state: ExecApprovalPromptState;
  getConnectedEpoch: () => number;
  getReviewGeneration: () => number;
  canReview: () => boolean;
  isCurrentClient: (client: GatewayBrowserClient) => boolean;
  isDisposed: () => boolean;
  publish: () => void;
}) {
  let generation = 0;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const cancel = () => {
    generation += 1;
    if (retryTimer !== null) {
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  const refresh = async (
    client: GatewayBrowserClient,
    epoch = params.getConnectedEpoch(),
    reviewGeneration = params.getReviewGeneration(),
  ) => {
    cancel();
    const refreshGeneration = generation;
    let retryDelayMs = 1_000;
    const isCurrent = () =>
      refreshGeneration === generation &&
      !params.isDisposed() &&
      epoch === params.getConnectedEpoch() &&
      reviewGeneration === params.getReviewGeneration() &&
      params.canReview() &&
      readGatewayOperatorAccess(params.gateway.snapshot).canReviewApprovals &&
      params.isCurrentClient(client);
    const run = async () => {
      if (!isCurrent()) {
        return;
      }
      const complete = await refreshPendingApprovalQueue(params.state, {
        isCurrentClient: (requestClient) => requestClient === client && isCurrent(),
      });
      if (!isCurrent()) {
        return;
      }
      params.publish();
      if (!complete) {
        retryTimer = globalThis.setTimeout(() => {
          retryTimer = null;
          void run();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 4_000);
      }
    };
    await run();
  };
  return { refresh, cancel };
}
