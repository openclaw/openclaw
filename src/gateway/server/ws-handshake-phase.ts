// Ordered handshake lifecycle for failure-only diagnostic phase logging.
// Phases advance monotonically; the last completed phase is included in close
// metadata when a connection ends before reaching `ready`.
export const WS_HANDSHAKE_PHASES = [
  "tcp_accepted",
  "ws_upgrade_started",
  "auth_token_received",
  "auth_validated",
  "session_attached",
  "subscriptions_registered",
  "ready",
] as const;
export type WsHandshakePhase = (typeof WS_HANDSHAKE_PHASES)[number];
