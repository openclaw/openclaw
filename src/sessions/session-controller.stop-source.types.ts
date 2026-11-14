// Leaf contract: run-stopped bookkeeping imports this without the stop module graph.
export type SessionStopSource =
  | "channel-user"
  | "client-session"
  | "client-run"
  | "talk"
  | "mutation"
  | "interrupt"
  | "restart"
  | "watchdog"
  | "operator-revocation"
  | "supersede";
