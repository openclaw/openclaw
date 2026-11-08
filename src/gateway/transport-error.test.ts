import { describe, expect, it } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  createGatewayCloseTransportError,
  createGatewayTimeoutTransportError,
  GatewayTransportError,
  isGatewayRpcUnavailableError,
} from "./transport-error.js";

const connectionDetails = {
  url: "ws://127.0.0.1:18789",
  urlSource: "local loopback",
  message: "Gateway target: ws://127.0.0.1:18789",
};
const transportError = (
  params: Omit<ConstructorParameters<typeof GatewayTransportError>[0], "connectionDetails">,
) => new GatewayTransportError({ connectionDetails, ...params });
const closed = (code?: number) => transportError({ kind: "closed", code, message: "unavailable" });

describe("Gateway RPC transport availability", () => {
  it.each([false, true])(
    "retains requestDispatched=%s across transport failures",
    (requestDispatched) => {
      const errors = [
        createGatewayCloseTransportError({
          code: 1006,
          reason: "connection interrupted",
          connectionDetails,
          requestDispatched,
        }),
        createGatewayTimeoutTransportError({
          timeoutMs: 1_500,
          connectionDetails,
          requestDispatched,
        }),
      ];
      expect(errors).toMatchObject([{ requestDispatched }, { requestDispatched }]);
    },
  );

  it.each(
    Object.entries({
      "typed connection close": closed(1006),
      "typed service restart": closed(1012),
      "typed socket failure without a close code": closed(),
      "typed connection timeout": transportError({
        kind: "timeout",
        timeoutMs: 1_500,
        message: "gateway timeout after 1500ms",
      }),
      "pending-request abnormal closure": new Error("gateway closed (1006): abnormal closure"),
      "pending-request service restart": new Error("gateway closed (1012): service restart"),
      "pending-request timeout": new Error("gateway timeout after 1500ms"),
      "pending-request timeout with connection details": new Error(
        "gateway timeout after 1500ms\nGateway target: ws://127.0.0.1:18789",
      ),
    }),
  )("recognizes %s as eligible for ownership-safe recovery", (_label, error) => {
    expect(isGatewayRpcUnavailableError(error)).toBe(true);
  });

  it.each([
    ...[1000, 1008, 1011, 4001].flatMap((code): Array<[string, unknown]> => [
      [`typed authoritative close ${code}`, closed(code)],
      [`plain authoritative close ${code}`, new Error(`gateway closed (${code}): rejected`)],
    ]),
    ...Object.entries({
      "credentials required": Object.assign(new Error("gateway requires credentials"), {
        name: "GatewayCredentialsRequiredError",
      }),
      "authoritative request rejection": new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "gateway closed (1006): request rejected",
      }),
      "already-dispatched request timeout": new GatewayProtocolRequestTimeoutError({
        method: "skills.workshop.read",
        timeoutMs: 1_500,
        requestSent: true,
      }),
      "arbitrary failure": new Error("gateway unavailable"),
      "noncanonical close": new Error("gateway closed (1006 abnormal closure): down"),
      "noncanonical timeout": new Error("gateway timeout after 1500ms: rejected"),
      "non-error transport-looking value": "gateway closed (1006): unavailable",
    }),
  ])("rejects %s as a recovery signal", (_label, error) => {
    expect(isGatewayRpcUnavailableError(error)).toBe(false);
  });
});
