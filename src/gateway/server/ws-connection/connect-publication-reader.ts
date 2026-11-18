import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import { PUBLICATION_READ_SCOPE } from "../../operator-scopes.js";
import { MAX_PAYLOAD_BYTES } from "../../payload-limits.js";
import { isPublicationReaderMethod, isPublicationReaderCurrent } from "../../publication-reader.js";
import { MAX_BUFFERED_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import type { GatewayWsClient } from "../ws-types.js";
import { resolveGatewayConnectPolicyFailure } from "./connect-admission.js";
import { prepareGatewayConnectOperatorDeviceSource } from "./connect-operator-access.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

/** Closed device lane: no human fallback, presence, UI capabilities, or session snapshot. */
export async function attachPublicationReader(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
): Promise<void> {
  const { handler } = context;
  const admission = state.publicationReader;
  const source = await prepareGatewayConnectOperatorDeviceSource(context, state, state.scopes);
  if (!source) {
    return;
  }
  if (
    !isPublicationReaderCurrent(admission) ||
    source.key !== admission.key ||
    source.deviceId !== admission.deviceId ||
    resolveGatewayConnectPolicyFailure(context, state)
  ) {
    context.markHandshakeFailure("publication-reader-authority-changed");
    context.sendHandshakeErrorResponse(
      ErrorCodes.FORBIDDEN,
      "publication reader authority changed",
    );
    handler.close(1008, "publication reader authority changed");
    return;
  }
  const receiver = handler.prepareAuthenticatedReceive("operator");
  if (!receiver.ok) {
    context.markHandshakeFailure(receiver.error.cause);
    context.sendHandshakeErrorResponse(ErrorCodes.UNAVAILABLE, receiver.error.message);
    handler.close(1011, receiver.error.message);
    return;
  }
  const client: GatewayWsClient = {
    socket: handler.socket,
    connect: context.connectParams,
    connId: handler.connId,
    connectionKind: "gateway",
    isDeviceTokenAuth: true,
    usesSharedGatewayAuth: false,
    authPolicy: state.authPolicy,
    internal: {
      authenticatedOperator: true,
      publicationReader: admission,
      operatorDeviceTokenIdentity: source,
    },
  };
  if (!handler.setClient(client)) {
    return;
  }
  handler.clearHandshakeTimer();
  receiver.value();
  handler.setHandshakeState("connected");
  handler.advanceHandshakePhase("session_attached");
  const registry = handler.getMethodRegistry?.();
  const methods =
    registry
      ?.listAdvertisedMethods()
      .filter((method) => isPublicationReaderMethod(registry, method)) ?? [];
  handler.advanceHandshakePhase("hello_payload_prepared");
  try {
    await context.sendFrame({
      type: "res",
      id: context.frame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: PROTOCOL_VERSION,
        server: { version: resolveRuntimeServiceVersion(process.env), connId: handler.connId },
        features: { methods, events: ["tick"] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { method: "device-token", role: "operator", scopes: [PUBLICATION_READ_SCOPE] },
        policy: {
          maxPayload: MAX_PAYLOAD_BYTES,
          maxBufferedBytes: MAX_BUFFERED_BYTES,
          tickIntervalMs: TICK_INTERVAL_MS,
        },
      },
    });
    context.onHelloDelivered();
  } catch {
    handler.setCloseCause("hello-send-failed");
    handler.close(1011, "gateway hello delivery failed");
  }
}
