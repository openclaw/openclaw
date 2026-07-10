// Runtime facade for Gateway calls used by outbound message delivery.
export {
  callGateway,
  callGatewayLeastPrivilege,
  randomIdempotencyKey,
} from "../../gateway/call.js";
