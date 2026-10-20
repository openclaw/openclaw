import { asNullableRecord as catalogRawRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { capturePlacementStartupConnection } from "../../app/session-placement-startup.ts";
import { menuOwnsShortcut } from "../../components/menu-shortcuts.ts";
import { hasModalSurface, registryFor } from "../../components/overlay-registry.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  PANE_SESSION_HANDOFF_TTL_MS,
  paneSessionHandoffs,
  removePaneSessionHandoffs,
  type PaneSessionHandoff,
  type PendingPaneSessionHandoff,
} from "./chat-pane-handoff-lifecycle.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export type PaneSessionChangeOptions = { replace?: boolean };
const PANE_SESSION_HANDOFF_LIMIT = 4;

function paneHandoffs(
  context: ApplicationContext,
  paneId: string,
  create: boolean,
): PendingPaneSessionHandoff[] | undefined {
  let byPane = paneSessionHandoffs.get(context);
  if (!byPane && create) {
    byPane = new Map();
    paneSessionHandoffs.set(context, byPane);
  }
  let pending = byPane?.get(paneId);
  if (!pending && create) {
    pending = [];
    byPane?.set(paneId, pending);
  }
  if (pending) {
    const now = Date.now();
    removePaneSessionHandoffs(pending, (handoff) => handoff.expiresAt <= now);
  }
  return pending;
}

export function preparePaneSessionHandoff(
  context: ApplicationContext,
  paneId: string,
  sessionKey: string,
  handoff: PaneSessionHandoff,
): void {
  const pending = paneHandoffs(context, paneId, true)!;
  removePaneSessionHandoffs(pending, (candidate) =>
    areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
  );
  const owner = context.gateway.snapshot.client;
  const sameConnection = capturePlacementStartupConnection(context.gateway, {
    gatewayUrl: context.gateway.connection.gatewayUrl,
    recoveryScope: owner?.recoveryScope || undefined,
  });
  const stored = {
    sessionKey,
    value: { ...handoff },
    isCurrent: () => context.gateway.snapshot.client === owner && sameConnection(),
    expiresAt: Date.now() + PANE_SESSION_HANDOFF_TTL_MS,
  };
  pending.push(stored);
  globalThis.setTimeout(() => {
    paneHandoffs(context, paneId, false);
  }, PANE_SESSION_HANDOFF_TTL_MS);
  while (pending.length > PANE_SESSION_HANDOFF_LIMIT) {
    pending.shift();
  }
}

export function consumePaneSessionHandoff(
  context: ApplicationContext,
  paneId: string,
  sessionKey: string,
): PaneSessionHandoff | null {
  const pending = paneHandoffs(context, paneId, false);
  const index = pending?.findIndex(
    (candidate) =>
      candidate.isCurrent() && areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
  );
  if (!pending || index === undefined || index < 0) {
    return null;
  }
  return pending.splice(index, 1)[0]!.value;
}

export function clearPaneSessionHandoff(
  context: ApplicationContext,
  paneId: string,
  sessionKey: string,
): void {
  removePaneSessionHandoffs(paneHandoffs(context, paneId, false), (handoff) =>
    areUiSessionKeysEquivalent(handoff.sessionKey, sessionKey),
  );
}

export function clearPaneSessionHandoffs(context: ApplicationContext, paneId: string): void {
  const byPane = paneSessionHandoffs.get(context);
  if (!byPane?.delete(paneId)) {
    return;
  }
  if (byPane.size === 0) {
    paneSessionHandoffs.delete(context);
  }
}

export type ResolvedBoardView = {
  provider: BoardProvider;
  snapshot: BoardSnapshot;
  available: boolean;
  hasBoard: boolean;
  face: BoardFace;
  activeTabId: string;
};

export const CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS = 500;
// One distance owns both halves of early history loading: upward intent within
// this range arms the sentinel observer, and the observer's rootMargin fires
// the same distance out. Splitting them re-creates the wall at the smaller value.
export const CHAT_HISTORY_PREFETCH_EDGE_PX = 1200;
export const CHAT_HISTORY_INTENT_IDLE_MS = 200;

export function catalogRawString(raw: unknown, keys: readonly string[]): string | null {
  const record = catalogRawRecord(raw);
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
export function catalogRawResult(raw: unknown): string | null {
  const result = catalogRawRecord(raw)?.result;
  try {
    return JSON.stringify(result) || null;
  } catch {
    return null;
  }
}

export type ChatPaneConnectionScope = {
  context: ApplicationContext;
  state: ChatPageHost;
  client: GatewayBrowserClient;
  generation: number;
  headerOutcomeOwner: string;
  sessions: ApplicationContext["sessions"];
};
// Menus without typeahead own activation/navigation, not printable input.
// Keeping those key classes separate prevents an open menu from silently dropping a letter.
const CHAT_PRINTABLE_KEY_TARGET_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='combobox'], [role='textbox'], [data-chat-autotype-exempt]";
const CHAT_SPACE_ACTIVATION_SELECTOR =
  "a[href], button, summary, [role='button'], [role='checkbox'], [role='link'], [role='listbox'], [role='menu'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], [role='radio'], [role='switch'], [role='tab']";
const CHAT_DROPDOWN_KEYS = new Set([
  " ",
  "Enter",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Escape",
]);
export const NEW_SESSION_ACTIVE_RUN_MESSAGE =
  "Start a new session after the active run or queued messages finish.";
export const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
export const NEW_SESSION_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new thread. Try again in a moment.";

function keyboardEventPathHasInteractiveTarget(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        (target.matches("dialog[open], [aria-modal='true']") ||
          target.matches(CHAT_PRINTABLE_KEY_TARGET_SELECTOR) ||
          menuOwnsShortcut(target, event.key) ||
          (event.key === " " && target.matches(CHAT_SPACE_ACTIVATION_SELECTOR))),
    );
}

function openDropdownOwnsKey(root: HTMLElement, key: string): boolean {
  // Portaled menus can belong to any surface in the containing app.
  const surface = root.closest("openclaw-app, openclaw-app-shell") ?? root;
  return [...registryFor(root.ownerDocument).members.keys()].some(
    (overlay) =>
      surface.contains(overlay.surface) &&
      overlay.open &&
      overlay.surface.matches('[role="menu"][popover]') &&
      !overlay.surface.closest("[inert]") &&
      (CHAT_DROPDOWN_KEYS.has(key) || menuOwnsShortcut(overlay.surface, key)),
  );
}

export function focusChatComposerFromPrintableKeydown(
  root: HTMLElement,
  event: KeyboardEvent,
  composer: HTMLTextAreaElement | null,
): void {
  // Native callers cross modal and composer renderer boundaries to transfer keyboard ownership.
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    openDropdownOwnsKey(root, event.key) ||
    event.key.length !== 1 ||
    keyboardEventPathHasInteractiveTarget(event) ||
    root.closest("[inert]") ||
    hasModalSurface(root.ownerDocument)
  ) {
    return;
  }
  if (!composer || composer.disabled || composer.readOnly) {
    return;
  }
  // Focus transfers ownership; block old-target dropdown typeahead from cancelling input.
  composer.focus({ preventScroll: true });
  event.stopImmediatePropagation();
}
