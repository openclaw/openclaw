import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { normalizeSidebarLayout } from "../chat/sidebar-layout-normalize.ts";
import type { SidebarLayout, SidebarPanel } from "../chat/sidebar-layout-types.ts";

export type PanelEmbedTarget = {
  agentId: string;
  sessionKey: string;
  panel: SidebarPanel | null;
  resourceAutoOpenDismissed: boolean;
  url?: string;
  path?: string;
};

/** The native host supplies a literal session identity, never the web's last-used session. */
export function parsePanelEmbedTarget(search: string): PanelEmbedTarget | null {
  const params = new URLSearchParams(search);
  const agentId = params.get("agent")?.trim();
  const sessionKey = params.get("session")?.trim();
  const slot = params.get("slot");
  if (!agentId || !sessionKey || !slot) {
    return null;
  }
  const owner = parseAgentSessionKey(sessionKey)?.agentId;
  if (owner && owner !== agentId) {
    return null;
  }
  const layout = normalizeSidebarLayout({
    columns: [
      {
        side: "right",
        panels: [
          {
            id: slot,
            slot,
            taskId: params.get("taskId"),
            portalId: params.get("portalId"),
            environmentId: params.get("environmentId"),
          },
        ],
      },
    ],
  });
  const panel = layout.columns[0]?.panels[0] ?? null;
  if (slot !== "picker" && panel?.slot !== slot) {
    return null;
  }
  return {
    agentId,
    sessionKey,
    panel,
    resourceAutoOpenDismissed: params.get("resourceAutoOpenDismissed") === "1",
    ...(slot === "link-reader" && params.get("url")?.trim()
      ? { url: params.get("url")!.trim() }
      : {}),
    ...(slot === "workspace" && params.get("path")?.trim()
      ? { path: params.get("path")!.trim() }
      : {}),
  };
}

export function panelEmbedLayout(target: PanelEmbedTarget): SidebarLayout {
  return {
    columns: target.panel
      ? [
          {
            id: "embed",
            side: "right",
            panels: [{ ...target.panel }],
            activePanelId: target.panel.id,
            width: 480,
            height: 360,
          },
        ]
      : [],
    mainPanelId: target.panel?.id,
    open: false,
    resourceAutoOpenDismissed: target.resourceAutoOpenDismissed,
  };
}
