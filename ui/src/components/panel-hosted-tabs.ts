import type { nothing, TemplateResult } from "lit";

export const PANEL_HOSTED_TABS_CHANGE_EVENT = "openclaw:panel-hosted-tabs-change";

export type PanelHostedTab = {
  id: string;
  label: string;
  /** Page URL used for hostname favicon lookup when no explicit favicon is available. */
  url?: string;
  /** Explicit icon URL; takes precedence over hostname lookup and `icon`. */
  favicon?: string;
  icon?: TemplateResult;
  title?: string | null;
  statusLabel?: string | null;
  badge?: string | null;
  className?: string;
};

export type PanelHostedTabsElement = HTMLElement & {
  readonly hostedTabs: PanelHostedTab[];
  readonly activeHostedTabId: string | null;
  /** Header actions while this panel is the active side panel; rendered by the host in light DOM. */
  readonly hostedActions?: TemplateResult | typeof nothing;
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
