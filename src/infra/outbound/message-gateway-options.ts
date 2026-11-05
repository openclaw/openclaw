// Gateway option normalization hides transport URL details for backend/managed
// gateway clients and clamps timeout values.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { GatewayProtocolRequestTimeoutError } from "../../../packages/gateway-client/src/protocol-request.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../utils/message-channel.js";

// Direct sends and option normalization must not load the Gateway runtime.
export const loadMessageGatewayRuntime = createLazyRuntimeModule(
  () => import("./message.gateway.runtime.js"),
);

/** How long a same-key send retry may wait for the Gateway's original work. */
export const GATEWAY_SEND_RECONCILIATION_TIMEOUT_MS = 60_000;

/** A caller-side timeout after dispatch leaves the Gateway's work running. */
export async function isUnsettledGatewayRequestTimeout(error: unknown): Promise<boolean> {
  if (error instanceof GatewayProtocolRequestTimeoutError) {
    return error.requestSent;
  }
  // Ordinary send failures settle without loading the Gateway runtime.
  if (!(error instanceof Error) || error.name !== "GatewayTransportError") {
    return false;
  }
  const { isGatewayTransportError } = await loadMessageGatewayRuntime();
  // A startup or pre-hello timeout never reached the Gateway, so a retry would send anew.
  return (
    isGatewayTransportError(error) && error.kind === "timeout" && error.requestDispatched === true
  );
}

export async function resolveGatewayIdempotencyKey(idempotencyKey?: string): Promise<string> {
  if (idempotencyKey) {
    return idempotencyKey;
  }
  const { randomIdempotencyKey } = await loadMessageGatewayRuntime();
  return randomIdempotencyKey();
}

export type OutboundGatewayRequest = Pick<
  CallGatewayOptions,
  "method" | "params" | "timeoutMs" | "signal"
>;

export type OutboundGatewayRequestContext = {
  sourceReplyFinal?: boolean;
  sourceReplyToolCallId?: string;
};

/** Raw gateway options accepted by outbound message senders. */
export type OutboundMessageGatewayOptionsInput = Pick<
  CallGatewayOptions,
  "config" | "localPortOverride" | "ignoreEnvUrlOverride" | "tlsFingerprint"
> & {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  mode?: GatewayClientMode;
  /** Host-bound dispatch keeps delivery with its Gateway without opening a transport. */
  request?: <T>(
    request: OutboundGatewayRequest,
    context?: OutboundGatewayRequestContext,
  ) => Promise<T>;
  resolveAgentRuntimeIdentityToken?: () => Promise<string | undefined>;
};

/** Normalizes outbound gateway options and fills CLI defaults. */
export function resolveOutboundMessageGatewayOptions(gateway?: OutboundMessageGatewayOptionsInput) {
  const clientName = gateway?.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
  const mode = gateway?.mode ?? GATEWAY_CLIENT_MODES.CLI;
  // Backend-mode callers and gateway clients use the managed transport endpoint.
  const url =
    mode === GATEWAY_CLIENT_MODES.BACKEND || clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT
      ? undefined
      : gateway?.url;
  return {
    config: gateway?.config,
    localPortOverride: gateway?.localPortOverride,
    ignoreEnvUrlOverride: gateway?.ignoreEnvUrlOverride,
    tlsFingerprint: gateway?.tlsFingerprint,
    url,
    token: gateway?.token,
    timeoutMs: resolveTimerTimeoutMs(gateway?.timeoutMs, 10_000),
    clientName,
    clientDisplayName: gateway?.clientDisplayName,
    mode,
  };
}
