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
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { closeSlot, openSlot, setSidebarDock } from "./sidebar-layout.ts";

interface ActivePanelOwner {
  renderRoot: ParentNode;
  state: ChatPageHost;
  linkReaders: readonly ControlUiLinkReaderDescriptor[];
  pluginPanels: readonly `${string}/${string}`[];
  updateComplete: Promise<unknown>;
}

export type PendingSessionPanelToggle = {
  events: Event[];
  owner: ChatPageHost;
  sessionKey: string;
};

interface SessionPanelToggleOptions {
  current: () => ActivePanelOwner | null;
  pending: Map<SessionPanelToggleSlot, PendingSessionPanelToggle>;
  requestUpdate: () => void;
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
      options.pending.delete(slot);
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
      const embeddedTerminal = owner.renderRoot.querySelector<
        HTMLElementTagNameMap["openclaw-terminal-panel"]
      >("openclaw-terminal-panel[embedded]");
      const terminalConstructor = customElements.get("openclaw-terminal-panel");
      const embeddedTerminalMounted =
        embeddedTerminal !== null &&
        terminalConstructor !== undefined &&
        embeddedTerminal instanceof terminalConstructor;
      if (embeddedTerminalMounted) {
        embeddedTerminal.activateTerminalHost();
      }
      if (intent) {
        void terminalIntentQueue.queue(intent, {
          deferUntilHostChange: !embeddedTerminalMounted,
        });
      }
      options.updateSidebarLayout(layout);
      return;
    }
    const existing = options.pending.get(slot);
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
      options.pending.get(slot) === queue &&
      options.current()?.state === owner.state &&
      owner.state.sessionKey === sessionKey;
    options.pending.set(slot, queue);
    options.updateSidebarLayout(layout);
    void Promise.all([
      customElements.whenDefined("openclaw-chat-sidebar-region"),
      customElements.whenDefined(tagName),
    ])
      .then(async () => {
        options.requestUpdate();
        // requestUpdate schedules a new commit; the captured owner holds the previous promise.
        await options.current()?.updateComplete;
        if (!isCurrent()) {
          return;
        }
        const region = owner.renderRoot.querySelector<
          HTMLElementTagNameMap["openclaw-chat-sidebar-region"]
        >("openclaw-chat-sidebar-region");
        await region?.updateComplete;
        if (!isCurrent()) {
          return;
        }
        // The region's sibling outlet can connect a panel before its owner has committed.
        const recipient =
          owner.renderRoot.querySelector<HTMLElementTagNameMap[PanelTagName]>(tagName);
        await recipient?.updateComplete;
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
        if (options.pending.get(slot) === queue) {
          options.pending.delete(slot);
          options.requestUpdate();
        }
      });
  }

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

  const listeners = new AbortController();
  const listenerOptions = { signal: listeners.signal };
  for (const [eventName, slot, tagName] of panelToggleEvents) {
    window.addEventListener(eventName, (event) => handle(slot, tagName, event), listenerOptions);
  }
  window.addEventListener(PLUGIN_PANEL_TOGGLE_EVENT, handlePluginPanel, listenerOptions);
  window.addEventListener(
    TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
    () => {
      const owner = options.current();
      if (owner) {
        owner.state.updateSidebarLayout(closeSlot(owner.state.sidebarLayout, "terminal"));
      }
    },
    listenerOptions,
  );
  onCleanup(() => {
    listeners.abort();
    options.pending.clear();
  });
  return flush;
}
