import { isSessionRouteId } from "../app-route-paths.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { subscribeArchiveStarts } from "./session-archive-hold.ts";

/** The chat below the archived one in the sidebar, or the one above when it was last. */
export function resolveArchiveSuccessor(
  archivedKey: string,
  order: readonly string[],
  canOpen: (key: string) => boolean,
): string | undefined {
  const index = order.findIndex((key) => areUiSessionKeysEquivalent(key, archivedKey));
  if (index < 0) {
    return undefined;
  }
  return order.slice(index + 1).find(canOpen) ?? order.slice(0, index).findLast(canOpen);
}

export type SidebarArchiveAdvanceHost = {
  /** The open chat, or "" outside session routes. */
  currentSessionKey(): string;
  visibleSessionKeysInOrder(): readonly string[];
  canOpenSession(key: string): boolean;
  openSession(key: string): void;
};

/**
 * Archiving the open chat opens its sidebar neighbor, as archiving does in a mail client,
 * instead of leaving an archived conversation on screen. Undo still only brings the row back.
 */
export function createSidebarArchiveAdvance(host: SidebarArchiveAdvanceHost) {
  // The last rendered order. An archive hides its rows before it starts, so a fresh
  // read could no longer place the archived chat between its neighbors.
  let order: readonly string[] = [];
  let stop: (() => void) | undefined;

  const advance = (archivedKeys: readonly string[]) => {
    const current = host.currentSessionKey();
    const isArchived = (key: string) =>
      archivedKeys.some((archived) => areUiSessionKeysEquivalent(archived, key));
    if (!current || !isArchived(current)) {
      return;
    }
    const next = resolveArchiveSuccessor(
      current,
      order,
      (key) => !isArchived(key) && host.canOpenSession(key),
    );
    if (!next) {
      // Nothing else to open: the archived chat stays with its Unarchive banner.
      return;
    }
    // Navigate once the archive has shown its Undo notice, and only if the chat is still open.
    queueMicrotask(() => {
      if (areUiSessionKeysEquivalent(host.currentSessionKey(), current)) {
        host.openSession(next);
      }
    });
  };

  return {
    /** Call after each render. Reading the order is skipped outside chats, where nothing advances. */
    sync(): void {
      stop ??= subscribeArchiveStarts(advance);
      order = host.currentSessionKey() ? host.visibleSessionKeysInOrder() : [];
    },
    disconnect(): void {
      stop?.();
      stop = undefined;
      order = [];
    },
  };
}

type SidebarArchiveAdvanceSource = {
  readonly activeRouteId: string | null | undefined;
  getRouteSessionKey(): string;
  visibleSessionTreeInOrder(): readonly { readonly key: string }[];
  findSidebarSessionByKey(key: string): unknown;
  selectSession(key: string): void;
};

/** Binds the advance to the sidebar's own order, row lookup, and session selection. */
export function createSidebarArchiveAdvanceFor(sidebar: SidebarArchiveAdvanceSource) {
  return createSidebarArchiveAdvance({
    currentSessionKey: () =>
      isSessionRouteId(sidebar.activeRouteId) ? sidebar.getRouteSessionKey() : "",
    visibleSessionKeysInOrder: () => sidebar.visibleSessionTreeInOrder().map((row) => row.key),
    canOpenSession: (key) => sidebar.findSidebarSessionByKey(key) !== undefined,
    openSession: (key) => sidebar.selectSession(key),
  });
}
