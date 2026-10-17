import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { createDevicePairSetupState } from "../lib/device-pair-setup.ts";
import { refreshPendingApprovalQueue, type ExecApprovalPromptState } from "./exec-approval.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";

type OverlayOperatorAccess = ReturnType<typeof readGatewayOperatorAccess>;
type DevicePairSetupState = ReturnType<typeof createDevicePairSetupState>;

export function readOverlayOperatorAccessTransition(
  previous: OverlayOperatorAccess,
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

export function createOverlayPairingPendingCount(params: {
  gateway: ApplicationGateway;
  state: DevicePairSetupState;
  isDisposed: () => boolean;
  publish: () => void;
}) {
  let generation = 0;

  return {
    invalidate(options: { clear?: boolean } = {}) {
      generation += 1;
      if (options.clear) {
        params.state.pendingCount = 0;
      }
    },

    async refresh() {
      const client = params.gateway.snapshot.client;
      if (
        !client ||
        params.gateway.snapshot.phase !== "connected" ||
        params.isDisposed() ||
        !params.state.devicePairSetupOpen ||
        !readGatewayOperatorAccess(params.gateway.snapshot).canAdmin
      ) {
        return;
      }
      const requestGeneration = ++generation;
      let result: { pending?: unknown };
      try {
        result = await client.request<{ pending?: unknown }>("device.pair.list", {});
      } catch {
        return;
      }
      if (
        params.isDisposed() ||
        requestGeneration !== generation ||
        params.gateway.snapshot.client !== client ||
        params.gateway.snapshot.phase !== "connected" ||
        !params.state.devicePairSetupOpen ||
        !readGatewayOperatorAccess(params.gateway.snapshot).canAdmin
      ) {
        return;
      }
      params.state.pendingCount = Array.isArray(result.pending) ? result.pending.length : 0;
      params.publish();
    },
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
