import { McpAppIcon } from "../../../components/mcp-app-icon.tsx";
import { notifyPanelHostedTabsChanged } from "../../../components/panel-hosted-tabs.ts";
import type { ChatDetailPanelContent } from "./chat-sidebar-content-types.ts";
import type { ChatDetailPanel } from "./chat-sidebar-view-types.ts";

/** The detail content owns its App identity; the Review launcher remains a panel type. */
export function bindMcpAppTab(
  host: ChatDetailPanel,
  current: () => ChatDetailPanelContent | null,
  close: () => void,
) {
  const app = () => {
    const content = current();
    return content?.kind === "mcp-app-preview" ? content : undefined;
  };
  // Create under the detail panel's retained owner, not the header's transient projection.
  const icon = (
    <McpAppIcon
      icons={app()?.appIdentity?.icons ?? []}
      pluginId={app()?.appIdentity?.pluginId}
      class="tabstrip-tab__favicon"
    />
  );
  Object.defineProperties(host, {
    hostedTabs: {
      configurable: true,
      get: () => {
        const content = app();
        return content ? [{ id: "mcp-app", label: content.title, icon }] : [];
      },
    },
    activeHostedTabId: { configurable: true, get: () => (app() ? "mcp-app" : null) },
  });
  // This surface exposes only its current App, not a second tab-selection owner.
  Object.assign(host, {
    selectHostedTab: () => {},
    closeHostedTab: async () => {
      close();
    },
  });
  return (content: ChatDetailPanelContent | null) => {
    const identity = content?.kind === "mcp-app-preview" ? content : undefined;
    notifyPanelHostedTabsChanged(host, [identity?.title, identity?.appIdentity]);
  };
}
