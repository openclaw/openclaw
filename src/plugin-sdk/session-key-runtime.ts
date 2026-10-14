/**
 * Runtime SDK subpath for session-key comparison and agent identity.
 */
export {
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
export { normalizeSessionKeyForComparison } from "../../packages/normalization-core/src/session-key-comparison.js";
