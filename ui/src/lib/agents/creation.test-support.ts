import { retainGatewayResponsePayload } from "../../../../packages/gateway-client/src/protocol-request.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";

/** Simulate a correlated negative response, distinct from a lost transport response. */
export function agentCreationRejection(message: string) {
  const error = new GatewayRequestError({ code: "UNAVAILABLE", message });
  retainGatewayResponsePayload(error, undefined);
  return error;
}
