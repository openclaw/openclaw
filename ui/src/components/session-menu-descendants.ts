import type { GatewaySessionRow } from "../api/types.ts";
import { isSubagentSessionKey } from "../lib/sessions/session-key.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

/** Unloaded worker branches stay out of childSessionKeys but keep a load parent. */
export function sidebarSessionHasArchiveDescendants(
  session: Pick<SidebarRecentSession, "childSessionKeys" | "childLoadParentKeys">,
): boolean {
  return session.childSessionKeys.length > 0 || (session.childLoadParentKeys?.length ?? 0) > 0;
}

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
