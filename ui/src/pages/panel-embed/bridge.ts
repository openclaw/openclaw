import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { availableLinkReaders } from "../../app/link-reader-routing.ts";
import { nativePanelBridge } from "../../app/native-web-chrome.ts";
import type { BrowserTabSelection } from "../../components/browser/browser-target.ts";
import { resolveLinkReaderTarget } from "../../components/link-reader-target.ts";
import type { SidebarPanelDefinition } from "../chat/components/chat-sidebar-region-types.ts";
import { sidebarActivePanel, sidebarMainPanel } from "../chat/sidebar-layout-geometry.ts";
import type { SidebarLayout, SidebarPanel } from "../chat/sidebar-layout-types.ts";
import type { PanelEmbedTarget } from "./target.ts";

/** Only the current embedded session may classify a native transcript link. */
export function subscribePanelEmbedLinks(
  target: PanelEmbedTarget,
  current: () => ApplicationGatewaySnapshot | null,
): () => void {
  const onLink = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    if (
      !isRecord(detail) ||
      detail.receiver !== "picker" ||
      target.panel !== null ||
      detail.agentId !== target.agentId ||
      detail.sessionKey !== target.sessionKey ||
      typeof detail.url !== "string" ||
      typeof detail.requestId !== "string"
    ) {
      return;
    }
    const snapshot = current();
    if (!snapshot) {
      return;
    }
    nativePanelBridge()?.postMessage({
      type: "openclaw-panel-link",
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      url: detail.url,
      requestId: detail.requestId,
      reader: resolveLinkReaderTarget(detail.url, availableLinkReaders(snapshot)) !== null,
    });
  };
  window.addEventListener("openclaw:native-panel-link", onLink);
  return () => window.removeEventListener("openclaw:native-panel-link", onLink);
}

export function publishPanelEmbedState(
  target: PanelEmbedTarget,
  definitions: SidebarPanelDefinition[],
  layout: SidebarLayout,
  previous: string,
  preferredBrowserTab?: BrowserTabSelection,
): string {
  const panels = layout.columns.flatMap((column) => column.panels);
  const isResource = (panel: SidebarPanel) => panel.slot === "browser" || panel.slot === "desktop";
  const openPanels = panels.filter(
    (panel) =>
      panel.slot !== "conversation" &&
      (panel.slot !== target.panel?.slot ||
        panel.taskId !== target.panel.taskId ||
        panel.portalId !== target.panel.portalId ||
        panel.environmentId !== target.panel.environmentId),
  );
  // A task-list click changes the selected detail without changing its main-panel placement.
  const changedTarget = openPanels.find((panel) => panel.slot === target.panel?.slot);
  const selected =
    changedTarget ?? (layout.open ? sidebarActivePanel(layout) : sidebarMainPanel(layout));
  const message = {
    type: "openclaw-panel-state",
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    panels: definitions.map(({ slot, label, available }) => ({ slot, label, available })),
    revealedSlots: panels
      .filter((panel) => isResource(panel) && panel.slot !== target.panel?.slot)
      .map((panel) => panel.slot),
    openPanels: openPanels.map(({ slot, taskId, portalId, environmentId }) => ({
      slot,
      taskId,
      portalId,
      environmentId,
    })),
    activeSlot:
      selected && !isResource(selected) && openPanels.includes(selected)
        ? selected.slot
        : undefined,
    resourceAutoOpenDismissed: layout.resourceAutoOpenDismissed === true,
    preferredBrowserTab,
  };
  const serialized = JSON.stringify(message);
  if (serialized !== previous) {
    nativePanelBridge()?.postMessage(message);
  }
  return serialized;
}
