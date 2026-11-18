import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  compareSessionRowsByActivity,
  filterVisibleSessionRows,
} from "../lib/sessions/navigation.ts";
import { isSessionSnoozed, nextSessionSnoozeWakeAt } from "../lib/sessions/session-snooze.ts";
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
 * Projects the sidebar roster for an open palette, once per roster publication,
 * open chat, and snooze deadline; the palette never issues its own list read.
 */
export class CommandPaletteRecentSessions {
  private cached:
    | {
        revision: number;
        currentSessionKey: string;
        wakeAt: number | null;
        items: readonly CommandPaletteItem[];
      }
    | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  /** `onDeadline` runs when a snoozed chat wakes, so an open palette shows it again. */
  constructor(private readonly onDeadline: () => void = () => undefined) {}

  read(
    sessions: ApplicationContext["sessions"] | undefined,
    input: RecentSessionsInput,
  ): readonly CommandPaletteItem[] {
    if (!input.open || !input.onSelectSession || !sessions) {
      this.reset();
      return NO_ITEMS;
    }
    const currentSessionKey = input.currentSessionKey?.() ?? "";
    const now = Date.now();
    const cached = this.cached;
    if (
      cached &&
      cached.revision === sessions.revision &&
      cached.currentSessionKey === currentSessionKey &&
      (cached.wakeAt === null || now < cached.wakeAt)
    ) {
      return cached.items;
    }
    // The sidebar keeps the last roster on screen while the Gateway reconnects; so does the palette.
    const rows = sessions.presentation.result?.sessions ?? [];
    const items = buildCommandPaletteRecentItems({
      rows,
      currentSessionKey,
      defaultAgentId: input.defaultAgentId,
      now,
    });
    const wakeAt = nextSessionSnoozeWakeAt(rows, now);
    this.cached = { revision: sessions.revision, currentSessionKey, wakeAt, items };
    this.scheduleWake(wakeAt, now);
    return items;
  }

  dispose(): void {
    this.reset();
  }

  private reset(): void {
    this.cached = undefined;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private scheduleWake(wakeAt: number | null, now: number): void {
    clearTimeout(this.wakeTimer);
    this.wakeTimer =
      wakeAt === null
        ? undefined
        : setTimeout(
            () => {
              this.wakeTimer = undefined;
              this.onDeadline();
            },
            Math.min(2_147_483_647, wakeAt - now + 1),
          );
  }
}
