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
import { lazySidebarElements } from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { closeSlot, openSlot, setSidebarDock } from "./sidebar-layout.ts";

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
}

const panelToggleEvents = [
  [TERMINAL_PANEL_TOGGLE_EVENT, "terminal", "openclaw-terminal-panel"],
  [BROWSER_PANEL_TOGGLE_EVENT, "browser", "openclaw-browser-panel"],
  [LINK_READER_PANEL_TOGGLE_EVENT, "link-reader", "openclaw-link-reader-panel"],
  [DESKTOP_PANEL_TOGGLE_EVENT, "desktop", "openclaw-desktop-panel"],
  [PORTAL_PANEL_TOGGLE_EVENT, "portal", "openclaw-portals-page"],
] as const;

type PanelTagName = (typeof panelToggleEvents)[number][2];

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
  }

  function handle(
    slot: (typeof panelToggleEvents)[number][1],
    tagName: PanelTagName,
    event: Event,
  ): void {
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
      return;
    }
    const queue: PendingSessionPanelToggle = {
      events: [event],
      owner: owner.state,
      sessionKey: owner.state.sessionKey,
    };
    const sessionKey = owner.state.sessionKey;
    const isCurrent = () =>
      options.pending.requests.get(slot) === queue &&
      options.current()?.state === owner.state &&
      owner.state.sessionKey === sessionKey;
    options.pending.requests = new Map(options.pending.requests).set(slot, queue);
    options.updateSidebarLayout(layout);
    void Promise.all([
      customElements.whenDefined("openclaw-chat-sidebar-region"),
      customElements.whenDefined(tagName),
    ])
      .then(async () => {
        // Definition precedes the lazy owner's publication that mounts its outlet.
        await Promise.all([
          lazySidebarElements.snapshot.get("region")?.pending,
          lazySidebarElements.snapshot.get(slot)?.pending,
        ]);
        if (!isCurrent()) {
          return;
        }
        await owner.awaitDomCommit();
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
    for (const [, slot, tagName] of panelToggleEvents) {
      let event: Event | null;
      while ((event = takeSessionPanelToggle(slot, owner.state.sessionKey))) {
        handle(slot, tagName, event);
      }
    }
  }

  const stop = panelToggleEvents.map(([eventName, slot, tagName]) =>
    listen(window, eventName, (event) => handle(slot, tagName, event)),
  );
  stop.push(
    listen(window, PLUGIN_PANEL_TOGGLE_EVENT, handlePluginPanel),
    listen(window, TERMINAL_PANEL_DOCK_BOTTOM_EVENT, () => {
      const owner = options.current();
      if (owner) {
        owner.state.updateSidebarLayout(closeSlot(owner.state.sidebarLayout, "terminal"));
      }
    }),
  );
  onCleanup(() => {
    stop.forEach((release) => release());
    options.pending.requests.clear();
  });
  return flush;
}
