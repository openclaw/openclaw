/**
 * Runtime SDK subpath for parsing agent ids from session keys.
 */
export {
  isIncognitoSessionKey,
  parseSessionDeliveryRoute,
  resolveAgentIdFromSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
