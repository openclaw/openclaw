import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  compareSessionRowsByActivity,
  filterVisibleSessionRows,
} from "../lib/sessions/navigation.ts";
import { isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";
import { SESSION_ACTION_PREFIX } from "./command-palette-session-search.ts";
import type { CommandPaletteState } from "./command-palette-state.ts";

/** Chats an empty palette offers before its commands. */
export const RECENT_SESSION_LIMIT = 8;

/**
 * Quick-switcher rows for an empty palette: unread chats first, then the most
 * recently active ones, so opening the palette and pressing Enter reaches the
 * newest unread chat, or the previous chat when nothing is unread.
 */
export function buildCommandPaletteRecentItems(params: {
  rows: readonly GatewaySessionRow[];
  currentSessionKey: string;
  defaultAgentId: string;
  now: number;
}): CommandPaletteItem[] {
  return filterVisibleSessionRows(params.rows, {
    agentId: params.defaultAgentId,
    defaultAgentId: params.defaultAgentId,
  })
    .filter((row) => row.key !== params.currentSessionKey && !isSessionSnoozed(row, params.now))
    .toSorted(
      (left, right) =>
        Number(right.unread === true) - Number(left.unread === true) ||
        compareSessionRowsByActivity(left, right),
    )
    .slice(0, RECENT_SESSION_LIMIT)
    .map<CommandPaletteItem>((row) => ({
      id: `recent-${row.key}`,
      label: resolveSessionDisplayName(row.key, row),
      icon: "messageSquare",
      category: row.unread === true ? "unread" : "recent",
      action: `${SESSION_ACTION_PREFIX}${row.key}`,
      session: row,
    }));
}

const NO_ITEMS: readonly CommandPaletteItem[] = [];

/** A palette publication plus the empty palette's chats. */
export type CommandPaletteSnapshot = ReturnType<CommandPaletteState["readProps"]> & {
  recentItems: readonly CommandPaletteItem[];
};

type RecentSessionsInput = Pick<
  ReturnType<CommandPaletteState["readProps"]>,
  "open" | "onSelectSession" | "currentSessionKey" | "defaultAgentId"
>;

/**
 * Projects the sidebar roster for an open palette, once per roster publication
 * and open chat; the palette never issues its own list read for these rows.
 */
export class CommandPaletteRecentSessions {
  private cached:
    | { revision: number; currentSessionKey: string; items: readonly CommandPaletteItem[] }
    | undefined;

  read(
    sessions: ApplicationContext["sessions"] | undefined,
    input: RecentSessionsInput,
  ): readonly CommandPaletteItem[] {
    if (!input.open || !input.onSelectSession || !sessions) {
      this.cached = undefined;
      return NO_ITEMS;
    }
    const currentSessionKey = input.currentSessionKey?.() ?? "";
    const cached = this.cached;
    if (
      cached &&
      cached.revision === sessions.revision &&
      cached.currentSessionKey === currentSessionKey
    ) {
      return cached.items;
    }
    const items = buildCommandPaletteRecentItems({
      rows: sessions.state.result?.sessions ?? [],
      currentSessionKey,
      defaultAgentId: input.defaultAgentId,
      now: Date.now(),
    });
    this.cached = { revision: sessions.revision, currentSessionKey, items };
    return items;
  }
}
