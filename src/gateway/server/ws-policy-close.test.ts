import { expect, it, vi } from "vitest";
import {
  holdGatewayPolicyResponse,
  invalidateGatewayPolicyClient,
  registerGatewayPolicyResponse,
} from "./ws-policy-close.js";

it("retains a credential-set response through its own policy refresh without admitting new requests", () => {
  const client = { socket: { close: vi.fn() } };
  const respond = vi.fn();
  const response = registerGatewayPolicyResponse("plugins.credentials.set", client, respond);
  expect(response).toBeDefined();
  holdGatewayPolicyResponse(respond);
  invalidateGatewayPolicyClient(client, {
    reason: "secret-rotation",
    code: 1008,
    message: "Reconnect",
    revokeSource: false,
  });
  expect(client).toMatchObject({ invalidated: true });
  expect(client.socket.close).not.toHaveBeenCalled();
  response!.finish();
  expect(client.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "Reconnect");
});
