import type { GatewaySessionRow } from "../../api/types.ts";
import { isSubagentSessionKey } from "./session-key.ts";

/** A tree action snapshots complete child windows, never just expanded sidebar rows. */
export async function collectSessionArchiveTree(params: {
  root: GatewaySessionRow;
  readChildren: (parentKey: string) => Promise<GatewaySessionRow[] | null>;
  isCurrent: () => boolean;
}): Promise<{
  rows: GatewaySessionRow[];
  ancestorsByKey: ReadonlyMap<string, readonly GatewaySessionRow[]>;
} | null> {
  const rows: GatewaySessionRow[] = [];
  const ancestorsByKey = new Map<string, readonly GatewaySessionRow[]>();
  const visited = new Set<string>();
  const pending: Array<{ row: GatewaySessionRow; ancestors: readonly GatewaySessionRow[] }> = [
    { row: params.root, ancestors: [] },
  ];
  while (pending.length > 0) {
    const { row, ancestors } = pending.shift()!;
    if (visited.has(row.key)) {
      continue;
    }
    visited.add(row.key);
    const persistent = !isSubagentSessionKey(row.key);
    if (
      row.archived ||
      (persistent && row !== params.root && (row.sidebarRoot || row.category?.trim()))
    ) {
      continue;
    }
    if (persistent) {
      rows.push(row);
      ancestorsByKey.set(row.key, ancestors);
    }
    const children = await params.readChildren(row.key);
    if (!params.isCurrent() || children === null) {
      return null;
    }
    const nextAncestors = persistent ? [row, ...ancestors] : ancestors;
    pending.push(...children.map((child) => ({ row: child, ancestors: nextAncestors })));
  }
  return { rows, ancestorsByKey };
}
