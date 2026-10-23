import { onCleanup } from "solid-js";
import type { ControlUiLinkReaderDescriptor } from "../../../../src/shared/control-ui-link-reader.js";
import { resolveLinkReaderTarget } from "../../components/link-reader-target.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  PORTAL_PANEL_TOGGLE_EVENT,
  PLUGIN_PANEL_TOGGLE_EVENT,
  type PluginPanelToggleDetail,
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../../components/panel-toggle-contract.ts";
import {
  clearSessionPanelToggle,
  panelToggleSessionKey,
  takeSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../../components/session-panel-toggle-buffer.ts";
import {
  terminalIntentQueue,
  terminalToggleIntent,
} from "../../components/terminal/terminal-pending-actions.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { closeSlot, openSlot, setSidebarDock, type SidebarSlotId } from "./sidebar-layout.ts";

interface ActivePanelOwner {
  sidebarRegion: HTMLElementTagNameMap["openclaw-chat-sidebar-region"] | null;
  state: ChatPageHost;
  linkReaders: readonly ControlUiLinkReaderDescriptor[];
  pluginPanels: readonly `${string}/${string}`[];
  awaitDomCommit(): Promise<unknown>;
}

export type PendingSessionPanelToggle = {
  events: Event[];
  owner: ChatPageHost;
  sessionKey: string;
};

interface SessionPanelToggleOptions {
  current: () => ActivePanelOwner | null;
  pending: { requests: Map<SessionPanelToggleSlot, PendingSessionPanelToggle> };
  updateSidebarLayout: (layout: ChatPageHost["sidebarLayout"]) => void;
  onOpenPanel?: (slot: SidebarSlotId) => void;
}

const panelToggleEvents = [
  [TERMINAL_PANEL_TOGGLE_EVENT, "terminal"],
  [BROWSER_PANEL_TOGGLE_EVENT, "browser"],
  [LINK_READER_PANEL_TOGGLE_EVENT, "link-reader"],
  [DESKTOP_PANEL_TOGGLE_EVENT, "desktop"],
  [PORTAL_PANEL_TOGGLE_EVENT, "portal"],
] as const;

function canOpenLinkReader(owner: ActivePanelOwner | null, url: string | undefined): boolean {
  return Boolean(
    owner?.state.connected &&
    owner.state.client &&
    owner.linkReaders.length > 0 &&
    (url === undefined || resolveLinkReaderTarget(url, owner.linkReaders)),
  );
}

/** Owns shell-to-pane panel intent handoff for the active chat presentation. */
export function createChatPaneSessionPanelToggles(options: SessionPanelToggleOptions): () => void {
  function deletePending(slot: SessionPanelToggleSlot): void {
    const requests = new Map(options.pending.requests);
    requests.delete(slot);
    options.pending.requests = requests;
  }

  function handlePluginPanel(event: Event): void {
    const owner = options.current();
    if (!owner || !(event instanceof CustomEvent)) {
      return;
    }
    // SAFETY: The typed host SDK and validated ui.command adapter own this event.
    const detail = event.detail as PluginPanelToggleDetail;
    const key = `${detail.pluginId}/${detail.panelId}` as const;
    if (
      !owner.pluginPanels.includes(key) ||
      !areUiSessionKeysEquivalent(detail.sessionKey, owner.state.sessionKey) ||
      (detail.agentId && detail.agentId !== resolveChatAgentId(owner.state))
    ) {
      return;
    }
    const slot = `plugin:${key}` as const;
    clearSessionPanelToggle(slot, event);
    let layout = detail.open
      ? openSlot(owner.state.sidebarLayout, slot)
      : closeSlot(owner.state.sidebarLayout, slot);
    if (detail.dock) {
      layout = setSidebarDock(layout, detail.dock);
    }
    options.updateSidebarLayout(layout);
    if (detail.open) {
      options.onOpenPanel?.(slot);
    }
  }

  function handle(slot: (typeof panelToggleEvents)[number][1], event: Event): void {
    const owner = options.current();
    if (!owner) {
      return;
    }
    const requestedSession = panelToggleSessionKey(event);
    if (requestedSession && !areUiSessionKeysEquivalent(requestedSession, owner.state.sessionKey)) {
      return;
    }
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (
      slot === "link-reader" &&
      detail?.open !== false &&
      !canOpenLinkReader(owner, detail?.url)
    ) {
      clearSessionPanelToggle(slot, event);
      return;
    }
    clearSessionPanelToggle(slot, event);
    if (slot === "link-reader") {
      event.preventDefault();
    }
    if (detail?.open === false) {
      deletePending(slot);
      options.updateSidebarLayout(closeSlot(owner.state.sidebarLayout, slot));
      return;
    }
    let layout = openSlot(owner.state.sidebarLayout, slot);
    if (detail?.dock === "right" || detail?.dock === "bottom") {
      layout = setSidebarDock(layout, detail.dock);
    }
    const panel = layout.columns
      .flatMap((column) => column.panels)
      .find((entry) => entry.slot === slot);
    if (
      panel &&
      slot === "desktop" &&
      requestedSession &&
      typeof detail?.environmentId === "string"
    ) {
      panel.environmentId = detail.environmentId;
    }
    if (panel && slot === "portal" && typeof detail?.portalId === "string") {
      panel.portalId = detail.portalId;
      delete panel.environmentId;
    } else if (panel && slot === "portal" && typeof detail?.environmentId === "string") {
      panel.environmentId = detail.environmentId;
      delete panel.portalId;
    }
    if (slot === "terminal") {
      const intent = terminalToggleIntent(event, resolveChatAgentId(owner.state));
      // A new pane can hold the tag before its lazy sidebar bridge upgrades it.
      const embeddedTerminalMounted = owner.sidebarRegion?.activateTerminalHost?.() ?? false;
      if (intent) {
        void terminalIntentQueue.queue(intent, {
          deferUntilHostChange: !embeddedTerminalMounted,
        });
      }
      options.updateSidebarLayout(layout);
      options.onOpenPanel?.(slot);
      return;
    }
    const existing = options.pending.requests.get(slot);
    if (
      slot === "link-reader" &&
      existing?.owner === owner.state &&
      existing.sessionKey === owner.state.sessionKey
    ) {
      existing.events.push(event);
      options.updateSidebarLayout(layout);
      options.onOpenPanel?.(slot);
      return;
    }
    const queue: PendingSessionPanelToggle = {
      events: [event],
      owner: owner.state,
      sessionKey: owner.state.sessionKey,
    };
    options.pending.requests = new Map(options.pending.requests).set(slot, queue);
    options.updateSidebarLayout(layout);
    options.onOpenPanel?.(slot);
    deliverPending(slot);
  }

  const delivering = new WeakSet<PendingSessionPanelToggle>();
  function deliverPending(slot: SessionPanelToggleSlot): void {
    const owner = options.current();
    const queue = options.pending.requests.get(slot);
    if (
      owner &&
      queue &&
      (queue.owner !== owner.state ||
        queue.sessionKey !== owner.state.sessionKey ||
        !owner.state.sidebarLayout.columns.some((column) =>
          column.panels.some((panel) => panel.slot === slot),
        ))
    ) {
      deletePending(slot);
      return;
    }
    if (!owner || !queue || delivering.has(queue) || !owner.sidebarRegion?.readPanelHost?.(slot)) {
      return;
    }
    const isCurrent = () =>
      options.pending.requests.get(slot) === queue &&
      options.current()?.state === owner.state &&
      owner.state.sessionKey === queue.sessionKey;
    delivering.add(queue);
    void owner
      .awaitDomCommit()
      .then(async () => {
        if (!isCurrent()) {
          return;
        }
        const region = options.current()?.sidebarRegion;
        await region?.awaitPanelCommit(slot);
        if (!isCurrent()) {
          return;
        }
        for (const pendingEvent of queue.events) {
          if (!isCurrent()) {
            return;
          }
          const current = options.current();
          const pendingDetail = pendingEvent instanceof CustomEvent ? pendingEvent.detail : null;
          if (slot === "link-reader" && !canOpenLinkReader(current, pendingDetail?.url)) {
            continue;
          }
          region?.deliverPanelEvent(slot, pendingEvent);
        }
      })
      .finally(() => {
        delivering.delete(queue);
        if (options.pending.requests.get(slot) === queue) {
          deletePending(slot);
        }
      });
  }

  // Deliver buffered shell intents in order after the lazy panel commits.
  function flush(): void {
    const owner = options.current();
    if (!owner) {
      return;
    }
    for (const key of owner.pluginPanels) {
      let event: Event | null;
      while (
        (event = takeSessionPanelToggle(
          `plugin:${key}`,
          owner.state.sessionKey,
          resolveChatAgentId(owner.state),
        ))
      ) {
        handlePluginPanel(event);
      }
    }
    for (const [, slot] of panelToggleEvents) {
      let event: Event | null;
      while ((event = takeSessionPanelToggle(slot, owner.state.sessionKey))) {
        handle(slot, event);
      }
    }
    for (const slot of options.pending.requests.keys()) {
      deliverPending(slot);
    }
  }

  const stop = panelToggleEvents.map(([eventName, slot]) =>
    listen(window, eventName, (event) => handle(slot, event)),
  );
  stop.push(
    listen(window, PLUGIN_PANEL_TOGGLE_EVENT, handlePluginPanel),
    listen(window, TERMINAL_PANEL_DOCK_BOTTOM_EVENT, () => {
      const owner = options.current();
      if (owner) {
        const layout = owner.state.sidebarLayout;
        const next = closeSlot(layout, "terminal");
        // Moving the terminal leaves the desktop panel open, even when its
        // last tab becomes the launcher. Mobile keeps its existing dismissal.
        if (owner.sidebarRegion?.presentation !== "mobile") {
          next.open = layout.open;
        }
        owner.state.updateSidebarLayout(next);
      }
    }),
  );
  onCleanup(() => {
    stop.forEach((release) => release());
    options.pending.requests.clear();
  });
  return flush;
}
