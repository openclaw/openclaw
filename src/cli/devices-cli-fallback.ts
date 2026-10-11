import { coerceErrorMessage as normalizeErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  readConnectPairingRequiredMessage,
  type ConnectPairingRequiredDetails,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import type { DevicePairingList } from "../gateway/device-pairing-list.types.js";
import { isLoopbackHost } from "../gateway/net.js";
import { isGatewayTransportError } from "../gateway/transport-error.js";
import { formatPairingApproveCommand } from "./pairing-command-format.js";

const FALLBACK_STATE_MISMATCH_MESSAGE =
  "Gateway requires device pairing, but local fallback pairing state does not contain the gateway request.";

export function resolveLocalPairingFallback(
  opts: { url?: string },
  error: unknown,
): { details: ConnectPairingRequiredDetails } | null {
  // Local fallback is only safe for implicit loopback gateway URLs.
  const message = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error));
  const details = readConnectPairingRequiredMessage(message);
  // Socket-connect failures have no close code: the transport never dispatched
  // a request. Unknown outcomes and protocol/auth failures cannot replay locally.
  const unreachable =
    isGatewayTransportError(error) &&
    error.kind === "closed" &&
    error.code === undefined &&
    error.requestDispatched !== true;
  if (!details && !unreachable) {
    return null;
  }
  if (typeof opts.url === "string" && opts.url.trim().length > 0) {
    // Explicit --url might point at a remote/tunneled gateway; never silently
    // switch to local pairing files in that case.
    return null;
  }
  const connection = buildGatewayConnectionDetails();
  if (connection.urlSource !== "local loopback") {
    return null;
  }
  try {
    return isLoopbackHost(new URL(connection.url).hostname) ? { details: details ?? {} } : null;
  } catch {
    return null;
  }
}

export function buildFallbackStateMismatchError(
  details: ConnectPairingRequiredDetails,
  pendingRequestIds: string[],
): Error {
  const heading = details.requestId
    ? `${FALLBACK_STATE_MISMATCH_MESSAGE} Missing requestId: ${details.requestId}.`
    : FALLBACK_STATE_MISMATCH_MESSAGE;
  // A populated local pending list means the CLI and gateway share this store:
  // each rejected connect re-mints the request, so the held id is stale rather
  // than foreign. Only an empty list suggests a genuinely different store, and
  // shared-auth flags are only a fix when the gateway actually uses shared auth.
  const currentRequestId = pendingRequestIds[0];
  const guidance = currentRequestId
    ? [
        "That request was superseded by a newer pending request.",
        `Approve the current request instead: ${formatPairingApproveCommand("devices", currentRequestId)}`,
      ]
    : [
        "The running gateway may be using a different OPENCLAW_PROFILE or OPENCLAW_STATE_DIR than this CLI.",
        "Rerun with the gateway's profile/state-dir; if the gateway uses shared auth, pass --token/--password to approve through it.",
      ];
  return new Error([heading, ...guidance].join("\n"));
}

export function assertLocalFallbackMatchesGatewayRequest(
  details: ConnectPairingRequiredDetails,
  list: DevicePairingList,
) {
  const requestId = normalizeOptionalString(details.requestId);
  if (!requestId) {
    return;
  }
  const pendingRequestIds = (list.pending ?? [])
    .map((request) => normalizeOptionalString(request.requestId))
    .filter((id): id is string => Boolean(id));
  if (!pendingRequestIds.includes(requestId)) {
    throw buildFallbackStateMismatchError(details, pendingRequestIds);
  }
}
