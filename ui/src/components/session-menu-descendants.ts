import type { GatewaySessionRow } from "../api/types.ts";
import { isSubagentSessionKey } from "../lib/sessions/session-key.ts";

/** Unknown worker branches keep discovery available; known empty branches do not. */
export function hasSessionArchiveDescendants(
  root: GatewaySessionRow,
  knownRows: readonly GatewaySessionRow[],
): boolean {
  if (isSubagentSessionKey(root.key)) {
    return false;
  }
  const rowsByKey = new Map(knownRows.map((row) => [row.key, row]));
  const pending = [...(root.childSessions ?? [])];
  const visited = new Set<string>([root.key]);
  for (const key of pending) {
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    const row = rowsByKey.get(key);
    if (row?.archived) {
      continue;
    }
    if (!isSubagentSessionKey(key)) {
      if (!row?.sidebarRoot && !row?.category?.trim()) {
        return true;
      }
    } else if (!row) {
      return true;
    } else {
      pending.push(...(row.childSessions ?? []));
    }
  }
  return false;
}
