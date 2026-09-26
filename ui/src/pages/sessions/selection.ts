import type { GatewaySessionRow } from "../../api/types.ts";

export type SessionDeleteRow = Pick<
  GatewaySessionRow,
  "key" | "archived" | "sessionId" | "label" | "displayName"
>;

export function reconcileSelectedSessions(
  selection: Map<string, SessionDeleteRow>,
  rows: readonly GatewaySessionRow[],
  isPending: (row: SessionDeleteRow) => boolean,
): Map<string, SessionDeleteRow> {
  const currentRows = new Map(rows.map((row) => [row.key, row]));
  const selected = new Map(selection);
  for (const [key, captured] of selected) {
    const current = currentRows.get(key);
    // Pending lifecycle overlays hide rows before the Gateway confirms them.
    // Keep that selection for rollback, but never transfer it to a successor.
    const retained = current
      ? Boolean(captured.sessionId?.trim()) && current.sessionId === captured.sessionId
      : isPending(captured);
    if (!retained) {
      selected.delete(key);
    }
  }
  return selected.size === selection.size ? selection : selected;
}

export function updateSelectedSessions(
  selection: ReadonlyMap<string, SessionDeleteRow>,
  rows: readonly GatewaySessionRow[],
  keys: readonly string[],
  mode: "select" | "toggle" | "deselect",
): Map<string, SessionDeleteRow> {
  const selected = new Map(selection);
  for (const key of keys) {
    if (mode === "deselect" || (mode === "toggle" && selected.has(key))) {
      selected.delete(key);
    } else {
      const row = rows.find((entry) => entry.key === key);
      if (row) {
        selected.set(key, { ...row });
      }
    }
  }
  return selected;
}
