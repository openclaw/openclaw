import type { ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import {
  SESSION_NAVIGATION_INTENT_EVENT,
  type SessionNavigationIntent,
} from "../../lib/sessions/navigation-handoff.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
} from "../../lib/sessions/session-key.ts";
import { clearPaneSessionHandoff, clearPaneSessionHandoffs } from "./chat-pane-shared.ts";
import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";
import type { ChatSplitLayout, ChatSplitPane } from "./split-layout-types.ts";
import { findPane, visiblePanesOf } from "./split-layout.ts";

export const QUEUED_EDIT_RETENTION_CHANGE_EVENT = "openclaw:queued-edit-retention-change";

const RETAINED_SESSIONS_PER_PANE = 3;
const SESSION_NAVIGATION_PREVIEW_TIMEOUT_MS = 5_000;

type RetentionHost = HTMLElement & { requestUpdate(): unknown };
type RetentionBindings = {
  context: () => ApplicationContext | undefined;
  presented: () => boolean;
  routeHref: () => string;
  layout: () => ChatSplitLayout;
  narrow: () => boolean;
  selectReplacement: (paneId: string, sourceSessionKey: string, sessionKey: string) => void;
  adoptNavigation: (paneId: string, sessionKey: string, agentId?: string) => void;
};

export class ChatPageRetainedSessions {
  private readonly sessionsByPane = new Map<string, Map<string, number>>();
  private readonly unbound = new Set<string>();
  private pendingAtFocus = new WeakSet<AbortController>();
  private preview: (SessionNavigationIntent & { href: string; paneId: string }) | null = null;
  private previewFrame: number | undefined;
  private previewTimer: number | undefined;

  constructor(
    private readonly host: RetentionHost,
    private readonly bindings: RetentionBindings,
  ) {}

  get unboundPaneIds(): ReadonlySet<string> {
    return this.unbound;
  }

  restore(panes: readonly ChatSplitPane[]): void {
    this.unbound.clear();
    this.pendingAtFocus = new WeakSet();
    for (const pane of panes) {
      if (isUiGlobalSessionKey(pane.sessionKey)) {
        this.unbound.add(pane.id);
      }
    }
    if (this.unbound.has(this.bindings.layout().activePaneId)) {
      this.capturePendingNavigation();
    }
  }

  bindPane(paneId: string): void {
    this.unbound.delete(paneId);
  }

  capturePendingNavigation(): void {
    const context = this.bindings.context();
    if (!context) {
      return;
    }
    const { matches, pendingMatches } = context.router.getState();
    this.pendingAtFocus = new WeakSet(
      [...matches, ...pendingMatches]
        .filter((match) => match.isFetching || match.status === "pending")
        .map((match) => match.abortController),
    );
  }

  wasPendingAtFocus(): boolean {
    return (
      this.bindings
        .context()
        ?.router.getState()
        .matches.some((match) => this.pendingAtFocus.has(match.abortController)) === true
    );
  }

  connect(): void {
    this.host.addEventListener(QUEUED_EDIT_RETENTION_CHANGE_EVENT, this.refreshRetention);
    window.addEventListener("popstate", this.cancelPreview);
    window.addEventListener(SESSION_NAVIGATION_INTENT_EVENT, this.handleNavigationIntent);
  }

  disconnect(): void {
    // Pane disconnects stage their scoped composer packages for a later chat
    // remount. Only an explicit pane/session close is terminal.
    this.sessionsByPane.clear();
    this.unbound.clear();
    this.pendingAtFocus = new WeakSet();
    this.host.removeEventListener(QUEUED_EDIT_RETENTION_CHANGE_EVENT, this.refreshRetention);
    window.removeEventListener("popstate", this.cancelPreview);
    window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, this.handleNavigationIntent);
    this.cancelPreview();
  }

  private readonly refreshRetention = () => {
    this.host.requestUpdate();
  };

  suspend(): void {
    this.cancelPreview();
  }

  settleRoute(): void {
    if (this.preview) {
      this.cancelPreview();
    }
  }

  retain(panes: readonly ChatSplitPane[]): ReadonlyMap<string, readonly (string | undefined)[]> {
    for (const paneId of this.unbound) {
      if (!panes.some((pane) => pane.id === paneId && isUiGlobalSessionKey(pane.sessionKey))) {
        this.unbound.delete(paneId);
      }
    }
    const bound = panes.filter((pane) => !this.unbound.has(pane.id));
    const paneIds = new Set(bound.map((pane) => pane.id));
    for (const paneId of this.sessionsByPane.keys()) {
      if (!paneIds.has(paneId)) {
        this.sessionsByPane.delete(paneId);
      }
    }
    return new Map(bound.map((pane) => [pane.id, this.retainPane(pane)]));
  }

  private retainPane(pane: ChatSplitPane): (string | undefined)[] {
    let retained = this.sessionsByPane.get(pane.id);
    if (!retained) {
      retained = new Map();
      this.sessionsByPane.set(pane.id, retained);
    }
    // Map order owns eviction recency; fixed slots keep surviving panes from
    // disconnecting when Lit removes or moves a sibling.
    const slots: (string | undefined)[] = Array.from(
      { length: RETAINED_SESSIONS_PER_PANE },
      () => undefined,
    );
    for (const [key, slot] of retained) {
      slots[slot] = key;
    }
    const retainedKey =
      [...retained.keys()].find(
        (key) => key === pane.sessionKey || areUiSessionKeysEquivalent(key, pane.sessionKey),
      ) ?? pane.sessionKey;
    let slot = retained.get(retainedKey);
    if (slot === undefined) {
      slot = slots.indexOf(undefined);
      if (slot < 0) {
        const candidate = [...retained].find(
          ([key]) => !this.findPane(pane.id, key)?.hasQueuedMessageEdit,
        );
        if (candidate) {
          const [evictedKey, evictedSlot] = candidate;
          this.findPane(pane.id, evictedKey)?.prepareForEviction?.();
          retained.delete(evictedKey);
          slot = evictedSlot;
        } else {
          // Unsaved corrections keep custody; ordinary navigation can use an
          // overflow slot until an edit resolves rather than discarding work.
          slot = slots.length;
        }
      }
      slots[slot] = retainedKey;
    }
    retained.delete(retainedKey);
    retained.set(retainedKey, slot);
    for (const [key, retainedSlot] of retained) {
      if (retained.size <= RETAINED_SESSIONS_PER_PANE) {
        break;
      }
      if (key === retainedKey || this.findPane(pane.id, key)?.hasQueuedMessageEdit) {
        continue;
      }
      this.findPane(pane.id, key)?.prepareForEviction?.();
      retained.delete(key);
      slots[retainedSlot] = undefined;
    }
    // Only trim empty tail slots: moving survivors would remount their panes.
    while (slots.length > RETAINED_SESSIONS_PER_PANE && slots.at(-1) === undefined) {
      slots.pop();
    }
    return slots;
  }

  discardPane(paneId: string): void {
    this.unbound.delete(paneId);
    const context = this.bindings.context();
    if (context) {
      clearPaneSessionHandoffs(context, paneId);
      context.chatAttachmentHandoff.clearPane(paneId);
    }
    this.sessionsByPane.delete(paneId);
  }

  readonly removeSession = (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
    preserveDraft = false,
  ): void => {
    const context = this.bindings.context();
    if (context && readDeletedSessionStartup(context, sessionKey)) {
      this.host.requestUpdate();
      return;
    }
    const deletedPane = this.findPane(paneId, sessionKey);
    if (!preserveDraft) {
      deletedPane?.discardStagedAttachments?.();
    }
    const retained = this.sessionsByPane.get(paneId);
    const retainedKey =
      retained && [...retained.keys()].find((key) => areUiSessionKeysEquivalent(key, sessionKey));
    if (retainedKey !== undefined) {
      retained?.delete(retainedKey);
    }
    if (context && !preserveDraft) {
      clearPaneSessionHandoff(context, paneId, sessionKey);
    }
    if (
      this.preview?.paneId === paneId &&
      areUiSessionKeysEquivalent(this.preview.sessionKey, sessionKey)
    ) {
      this.cancelPreview();
    }
    const selectedSessionKey = findPane(this.bindings.layout(), paneId)?.pane.sessionKey;
    if (selectedSessionKey && areUiSessionKeysEquivalent(selectedSessionKey, sessionKey)) {
      this.bindings.selectReplacement(paneId, sessionKey, replacementSessionKey);
    } else {
      this.host.requestUpdate();
    }
  };

  findPane(paneId: string, sessionKey: string): ChatPaneElement | undefined {
    return [...this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].find(
      (pane) =>
        pane.paneId === paneId && areUiSessionKeysEquivalent(pane.sessionKey ?? "", sessionKey),
    );
  }

  private readonly handleNavigationIntent = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    // A committed preview can still be waiting for route data after history
    // advances. New navigation retires it even when this page no longer owns
    // the URL and cannot preview the replacement itself.
    this.cancelPreview();
    if (!this.bindings.presented()) {
      return;
    }
    const intent = event.detail as SessionNavigationIntent;
    const layout = this.bindings.layout();
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    if (
      window.location.href !== this.bindings.routeHref() &&
      (!activePane || !this.unbound.has(activePane.id))
    ) {
      return;
    }
    if (
      activePane &&
      this.unbound.has(activePane.id) &&
      (!isUiGlobalSessionKey(intent.sessionKey) || intent.agentId)
    ) {
      event.preventDefault();
      if (intent.commit() && this.bindings.presented() && this.bindings.layout() === layout) {
        this.bindings.adoptNavigation(activePane.id, intent.sessionKey, intent.agentId);
      }
      return;
    }
    const retainedKey = [...(this.sessionsByPane.get(activePane?.id ?? "")?.keys() ?? [])].find(
      (key) => areUiSessionKeysEquivalent(key, intent.sessionKey),
    );
    if (
      !activePane ||
      !retainedKey ||
      this.findPane(activePane.id, retainedKey)?.routeFace !== intent.face ||
      areUiSessionKeysEquivalent(activePane.sessionKey, retainedKey)
    ) {
      return;
    }
    this.present(activePane.id, retainedKey, true);
    // The route remains authoritative for semantic/global ownership. Both
    // presentations stay inert until it settles; only visual ownership moves.
    const preview = {
      ...intent,
      href: window.location.href,
      paneId: activePane.id,
      sessionKey: retainedKey,
    };
    this.preview = preview;
    this.previewFrame = requestAnimationFrame(() => {
      if (this.preview !== preview) {
        return;
      }
      this.previewFrame = requestAnimationFrame(() => {
        this.previewFrame = undefined;
        if (
          this.preview === preview &&
          (window.location.href !== preview.href || !preview.commit())
        ) {
          this.cancelPreview();
        }
      });
    });
    this.previewTimer = window.setTimeout(
      this.cancelPreview,
      SESSION_NAVIGATION_PREVIEW_TIMEOUT_MS,
    );
    event.preventDefault();
  };

  private present(paneId: string, sessionKey: string, preview = false): void {
    const visible = visiblePanesOf(this.bindings.layout(), this.bindings.narrow()).some(
      (pane) => pane.id === paneId,
    );
    for (const pane of this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")) {
      if (pane.paneId !== paneId) {
        continue;
      }
      const selected = areUiSessionKeysEquivalent(pane.sessionKey ?? "", sessionKey);
      const presented = this.bindings.presented() && visible && selected;
      pane.classList.toggle("chat-pane-cache__pane--visible", selected);
      pane.visuallyPresented = presented;
      if (preview) {
        pane.toggleAttribute("inert", true);
        continue;
      }
      pane.toggleAttribute("inert", !presented);
      pane.setAttribute("aria-hidden", presented ? "false" : "true");
      pane.presented = presented;
    }
  }

  private clearPreviewWork(): void {
    if (this.previewFrame !== undefined) {
      cancelAnimationFrame(this.previewFrame);
      this.previewFrame = undefined;
    }
    if (this.previewTimer !== undefined) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
    }
  }

  private readonly cancelPreview = () => {
    const layout = this.bindings.layout();
    const paneId = this.preview?.paneId ?? layout.activePaneId;
    this.clearPreviewWork();
    this.preview = null;
    // A commit can focus another split. Restore the pane whose presentation
    // this preview changed using its current authoritative selection.
    const pane = findPane(layout, paneId)?.pane;
    if (pane) {
      this.present(pane.id, pane.sessionKey);
    }
  };
}
