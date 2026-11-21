import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import { PUBLICATION_READ_SCOPE } from "../../operator-scopes.js";
import { MAX_PAYLOAD_BYTES } from "../../payload-limits.js";
import {
  isPublicationTransportMethod,
  isPublicationTransportCurrent,
  PublicationTransportAdmissionError,
} from "../../publication-reader.js";
import { MAX_BUFFERED_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import type { GatewayWsClient } from "../ws-types.js";
import { resolveGatewayConnectPolicyFailure } from "./connect-admission.js";
import { prepareGatewayConnectOperatorDeviceSource } from "./connect-operator-access.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

export function rejectPublicationTransportAdmission(
  context: GatewayConnectPhaseContext,
  error: unknown,
): void {
  const disabled =
    error instanceof PublicationTransportAdmissionError &&
    error.failure.reason === "purpose-disabled"
      ? error.failure
      : undefined;
  const message = disabled
    ? `publication transport is disabled; enable gateway.sessionControl.${
        disabled.scope === PUBLICATION_READ_SCOPE
          ? "publicationReadEnabled"
          : "publicationWriteEnabled"
      }`
    : "publication transport requires an exact singleton paired device token";
  context.markHandshakeFailure(
    disabled ? "publication-transport-purpose-disabled" : "publication-transport-denied",
  );
  context.sendHandshakeErrorResponse(ErrorCodes.FORBIDDEN, message);
  context.handler.close(1008, message);
}

/** Closed device lane: no human fallback, presence, UI capabilities, or session snapshot. */
export async function attachPublicationTransport(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
): Promise<void> {
  const { handler } = context;
  const admission = state.publicationTransport;
  const source = await prepareGatewayConnectOperatorDeviceSource(context, state, state.scopes);
  if (!source) {
    return;
  }
  if (
    !isPublicationTransportCurrent(admission) ||
    source.key !== admission.key ||
    source.deviceId !== admission.deviceId ||
    resolveGatewayConnectPolicyFailure(context, state)
  ) {
    context.markHandshakeFailure("publication-transport-authority-changed");
    context.sendHandshakeErrorResponse(
      ErrorCodes.FORBIDDEN,
      "publication transport authority changed",
    );
    handler.close(1008, "publication transport authority changed");
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
    usesSharedGatewayAuth: state.sessionUsesSharedGatewayAuth,
    sharedGatewaySessionGeneration: state.sessionSharedGatewaySessionGeneration,
    authPolicy: state.authPolicy,
    internal: {
      authenticatedOperator: true,
      publicationTransport: admission,
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
      .filter((method) => isPublicationTransportMethod(registry, method, admission.scope)) ?? [];
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
        auth: { method: "device-token", role: "operator", scopes: [admission.scope] },
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
