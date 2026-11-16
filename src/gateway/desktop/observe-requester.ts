import type { IncomingMessage } from "node:http";
import {
  getRemoteControlUiIngressContext,
  hasCurrentRemoteControlUiIngress,
  readGatewayIngressTransport,
} from "../ingress-attribution.js";
import type { GatewayClient } from "../server-methods/client-types.js";
import type { RemoteIngressPrincipalSnapshot } from "../server/client-identity-types.js";

export type DesktopObserveRequester = {
  connId?: string;
  /** Display identity from authenticated Gateway metadata, never wire-supplied client labels. */
  operatorName?: string;
  signal?: AbortSignal;
  remoteIngressPrincipal?: RemoteIngressPrincipalSnapshot;
  openclawIdPeerKey?: string;
  isCurrent: () => boolean;
};

export function resolveDesktopObserveRequester(options: {
  client: GatewayClient | null;
  hasCurrentClientAuthority?: () => boolean;
}): DesktopObserveRequester | undefined {
  const { client, hasCurrentClientAuthority } = options;
  if (!client) {
    return undefined;
  }
  // Invalidation precedes the transport close event and its abort signal.
  return {
    connId: client.connId,
    operatorName:
      client.authenticatedUserProfile?.displayName?.trim() ||
      client.authenticatedUserId?.trim() ||
      undefined,
    signal: client.connectionSignal,
    remoteIngressPrincipal: client.internal?.remoteIngressPrincipal,
    openclawIdPeerKey: client.internal?.openclawIdPeerKey,
    isCurrent: () =>
      client.invalidated !== true &&
      !client.connectionSignal?.aborted &&
      hasCurrentClientAuthority?.() !== false,
  };
}

/** Redemption retains the issuing peer as well as the requester's live authority. */
export function hasCurrentDesktopObserveRequester(
  requester: DesktopObserveRequester | undefined,
  req?: IncomingMessage,
): boolean {
  if (requester?.isCurrent() === false) {
    return false;
  }
  if (!req) {
    return true;
  }
  const transport = readGatewayIngressTransport(req);
  const peerKey = transport?.kind === "openclaw-id-tunnel" ? transport.peerKey : undefined;
  const ingress = getRemoteControlUiIngressContext(req);
  return (
    requester?.openclawIdPeerKey === peerKey &&
    hasCurrentRemoteControlUiIngress(ingress) &&
    (!ingress ||
      requester?.remoteIngressPrincipal?.assertCurrent === ingress.resolvePrincipal().assertCurrent)
  );
}
