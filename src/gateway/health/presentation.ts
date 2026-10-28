import type { Snapshot } from "../../../packages/gateway-protocol/src/schema/snapshot.js";

/** Agent configuration and session activity remain available through the health RPC. */
export function projectHealthSummary({
  agents: _agents,
  sessions: _sessions,
  ...summary
}: Snapshot["health"]): Snapshot["health"] {
  return summary;
}
