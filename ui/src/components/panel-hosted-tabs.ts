export const PANEL_HOSTED_TABS_CHANGE_EVENT = "openclaw:panel-hosted-tabs-change";

export type PanelHostedTab = {
  id: string;
  label: string;
  url: string;
  kind: "remote" | "native";
};

export type PanelHostedTabsElement = HTMLElement & {
  readonly hostedTabs: PanelHostedTab[];
  readonly activeHostedTabId: string | null;
  selectHostedTab(id: string): void;
  closeHostedTab(id: string): Promise<void>;
};

export function readPanelHostedTabs(
  element: Element | null | undefined,
): PanelHostedTabsElement | null {
  // SAFETY: Probe an optional contract shape; its array and methods are checked below.
  const panel = element as Partial<PanelHostedTabsElement> | null | undefined;
  return panel &&
    Array.isArray(panel.hostedTabs) &&
    typeof panel.selectHostedTab === "function" &&
    typeof panel.closeHostedTab === "function"
    ? (panel as PanelHostedTabsElement) // SAFETY: The array and action checks identify the panel contract.
    : null;
}
