import { createContext, createSignal } from "solid-js";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

export function createSidebarRenameScope() {
  const [editors, setEditors] = createSignal(0);
  return {
    editing: () => editors() > 0,
    hold() {
      setEditors((count) => count + 1);
      return () => setEditors((count) => count - 1);
    },
  };
}

// Pinned and catalog rows can render outside a sortable Sessions section.
export const SidebarRenameScope = createContext<ReturnType<typeof createSidebarRenameScope> | null>(
  null,
);

/** Keep an editor connected, including its native composing range. Only order is held:
 * removed rows disappear, new rows join the list and retained rows use their latest facts. */
export function orderWhileRenaming(
  current: readonly SidebarRecentSession[],
  previous: readonly SidebarRecentSession[] | undefined,
  editing: (() => boolean) | undefined,
): readonly SidebarRecentSession[] {
  if (current.length < 2 || !previous?.length || !editing?.()) {
    return current;
  }
  const remaining = new Map(current.map((row) => [row.key, row]));
  const held: SidebarRecentSession[] = [];
  for (const row of previous) {
    const next = remaining.get(row.key);
    if (next) {
      held.push(next);
      remaining.delete(row.key);
    }
  }
  return [...held, ...remaining.values()];
}
