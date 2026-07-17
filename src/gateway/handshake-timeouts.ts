// Re-export gateway-client handshake timeout helpers so server code and client
// packages share the same preauth/connect timeout bounds.
export {
  getPreauthHandshakeTimeoutMsFromEnv,
  resolvePreauthHandshakeTimeoutMs,
} from "../../packages/gateway-client/src/timeouts.js";
