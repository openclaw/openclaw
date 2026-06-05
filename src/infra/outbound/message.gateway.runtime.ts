// Runtime facade for Gateway calls used by outbound message delivery.
export {
  callGatewayLeastPrivilege,
  callGatewayScoped,
  randomIdempotencyKey,
} from "../../gateway/call.js";
