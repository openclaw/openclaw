import type { Page } from "playwright";
import type { GatewaySessionRow } from "../api/types.ts";
import type { BoardWidget } from "../lib/board/types.ts";
import type { SidebarLayout } from "../pages/chat/sidebar-layout-types.ts";
import type { ChatSplitLayout } from "../pages/chat/split-layout-types.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";

export function sessionResponseCase(match: Record<string, unknown>, response: unknown) {
  return { cases: [{ match, response }] };
}

export async function seedChatSettings(page: Page, baseUrl: string, settings: object) {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    { key: controlUiBundledSettingsStorageKey(baseUrl), value: settings },
  );
}

export function splitColumns(
  rows: Pick<GatewaySessionRow, "key">[],
  activeIndex: number,
): ChatSplitLayout {
  return {
    activePaneId: `p${activeIndex + 1}`,
    columnWeights: rows.map(() => 1 / rows.length),
    columns: rows.map((row, index) => ({
      id: `c${index + 1}`,
      paneWeights: [1],
      panes: [{ id: `p${index + 1}`, sessionKey: row.key }],
    })),
  };
}

export function dashboardLayout(
  columnId: string,
  panelId: string,
  expanded: boolean,
): SidebarLayout {
  return {
    columns: [
      {
        id: columnId,
        side: "right",
        panels: [{ id: panelId, slot: "dashboard" }],
        activePanelId: panelId,
        width: 480,
        height: 360,
      },
    ],
    open: true,
    expanded,
    ...(expanded ? { mainPanelId: panelId } : {}),
  };
}

export function board(sessionKey: string, widgets: BoardWidget[] = []) {
  return {
    sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets,
  };
}

export function splitTranscripts(rows: Pick<GatewaySessionRow, "key" | "label">[]) {
  return Object.fromEntries(
    rows.map(({ key, label }) => [
      key,
      {
        messages: [{ role: "assistant", content: `Conversation ${label}`, timestamp: 1 }],
      },
    ]),
  );
}
