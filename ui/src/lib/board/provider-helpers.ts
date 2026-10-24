import type { BoardSnapshot } from "@openclaw/gateway-protocol";

export function emptyBoardSnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}
