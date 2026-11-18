// Desktop-host keyboard navigation between sidebar sessions: mod+1–9 opens a
// row by position and Control+Tab walks the sessions opened most recently.
import { isSessionRouteId } from "../app-route-paths.ts";
import { isNativeWebChromeHost } from "../app/native-web-chrome.ts";
import {
  resolveRecentSessionStep,
  resolveSessionJumpDigit,
} from "../lib/keyboard-shortcut-contract.ts";

/** Visits remembered for Control+Tab; older sessions fall off the end. */
export const MAX_RECENT_SIDEBAR_SESSIONS = 20;

export type SidebarSessionShortcutHost = {
  ownerDocument(): Document;
  isConnected(): boolean;
  /** Session keys in the order the sidebar shows them, children included when expanded. */
  visibleSessionKeysInOrder(): readonly string[];
  /** The session the current route shows, or an empty string. */
  currentSessionKey(): string;
  /** Whether a remembered session can still be opened from the sidebar. */
  canOpenSession(key: string): boolean;
  openSession(key: string): void;
};

/**
 * Most-recently-used order for Control+Tab. A held Control key walks one frozen
 * snapshot, like application switchers; releasing it promotes the final session.
 */
export class RecentSidebarSessions {
  private keys: string[] = [];
  private walk: { keys: string[]; index: number } | null = null;

  get walking(): boolean {
    return this.walk !== null;
  }

  get order(): readonly string[] {
    return this.keys;
  }

  visit(key: string): void {
    if (!key || this.walk) {
      return;
    }
    this.keys = [key, ...this.keys.filter((entry) => entry !== key)].slice(
      0,
      MAX_RECENT_SIDEBAR_SESSIONS,
    );
  }

  /** Returns the next session of the held walk, or null when nothing else is recent. */
  step(direction: 1 | -1, current: string, canOpen: (key: string) => boolean): string | null {
    if (!this.walk) {
      this.visit(current);
      const keys = this.keys.filter((key) => key === current || canOpen(key));
      if (keys.length < 2) {
        return null;
      }
      this.walk = { keys, index: 0 };
    }
    const { keys } = this.walk;
    this.walk.index = (this.walk.index + direction + keys.length) % keys.length;
    return keys[this.walk.index] ?? null;
  }

  finish(): void {
    const walk = this.walk;
    if (!walk) {
      return;
    }
    this.walk = null;
    this.visit(walk.keys[walk.index] ?? "");
  }
}

/** mod+1–8 opens that row; mod+9 opens the last row, matching browser tabs. */
export function resolveSessionJumpTarget(
  digit: number,
  keys: readonly string[],
): string | undefined {
  return digit === 9 ? keys.at(-1) : keys[digit - 1];
}

/** Without recent history, Control+Tab moves to the neighboring row, wrapping at the ends. */
export function resolveAdjacentSession(
  direction: 1 | -1,
  current: string,
  keys: readonly string[],
): string | undefined {
  if (keys.length === 0) {
    return undefined;
  }
  const index = keys.indexOf(current);
  if (index < 0) {
    return direction === 1 ? keys[0] : keys.at(-1);
  }
  const next = keys[(index + direction + keys.length) % keys.length];
  return next === current ? undefined : next;
}

export function createSidebarSessionShortcuts(host: SidebarSessionShortcutHost) {
  const recent = new RecentSidebarSessions();
  let document: Document | null = null;

  const open = (key: string | undefined) => {
    if (key && key !== host.currentSessionKey()) {
      host.openSession(key);
    }
  };

  const handleKeydown = (event: KeyboardEvent) => {
    // Browsers keep these chords for their own tabs; only desktop hosts deliver them.
    if (
      event.defaultPrevented ||
      event.isComposing ||
      !host.isConnected() ||
      !isNativeWebChromeHost() ||
      host.ownerDocument().openClawModalLayers?.size
    ) {
      return;
    }
    const digit = resolveSessionJumpDigit(event);
    if (digit !== null) {
      // Claim the chord even without a target so the host menu never reinterprets it.
      event.preventDefault();
      if (!event.repeat) {
        open(resolveSessionJumpTarget(digit, host.visibleSessionKeysInOrder()));
      }
      return;
    }
    const direction = resolveRecentSessionStep(event);
    if (direction === null) {
      return;
    }
    event.preventDefault();
    const current = host.currentSessionKey();
    open(
      recent.step(direction, current, (key) => host.canOpenSession(key)) ??
        resolveAdjacentSession(direction, current, host.visibleSessionKeysInOrder()),
    );
  };

  const handleKeyup = (event: KeyboardEvent) => {
    if (!event.ctrlKey) {
      recent.finish();
    }
  };
  const handleBlur = () => recent.finish();

  const connect = () => {
    if (document) {
      return;
    }
    document = host.ownerDocument();
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("keyup", handleKeyup);
    document.defaultView?.addEventListener("blur", handleBlur);
  };

  return {
    recent,
    /** Records the routed session; a held Control+Tab walk records only its final stop. */
    observe(key: string): void {
      recent.visit(key);
    },
    /** After each sidebar render: listen while connected and record the routed session. */
    sync(): void {
      if (host.isConnected()) {
        connect();
        recent.visit(host.currentSessionKey());
      }
    },
    connect,
    disconnect(): void {
      recent.finish();
      document?.removeEventListener("keydown", handleKeydown);
      document?.removeEventListener("keyup", handleKeyup);
      document?.defaultView?.removeEventListener("blur", handleBlur);
      document = null;
    },
  };
}

/** The sidebar facts the shortcuts read; resolved at key time, never cached. */
export type SidebarSessionShortcutSource = {
  readonly ownerDocument: Document;
  readonly isConnected: boolean;
  readonly activeRouteId: string | undefined;
  getRouteSessionKey(): string;
  shortcutSessionKeys(): string[];
  findSidebarSessionByKey(key: string): unknown;
  selectSession(key: string): void;
};

export function createSidebarSessionShortcutsFor(sidebar: SidebarSessionShortcutSource) {
  return createSidebarSessionShortcuts({
    ownerDocument: () => sidebar.ownerDocument,
    isConnected: () => sidebar.isConnected,
    visibleSessionKeysInOrder: () => sidebar.shortcutSessionKeys(),
    currentSessionKey: () =>
      isSessionRouteId(sidebar.activeRouteId) ? sidebar.getRouteSessionKey() : "",
    canOpenSession: (key) => sidebar.findSidebarSessionByKey(key) !== undefined,
    openSession: (key) => sidebar.selectSession(key),
  });
}
