export type SidebarSlotId =
  | "browser"
  | "link-reader"
  | "companion"
  | "conversation"
  | "dashboard"
  | "desktop"
  | "detail"
  | "discussion"
  | "portal"
  | "tasks"
  | "terminal"
  | "workspace"
  | `plugin:${string}/${string}`;
export type SidebarPanel = {
  id: string;
  slot: SidebarSlotId;
  environmentId?: string;
  portalId?: string;
  /** Selected task within the Tasks panel; absence shows its list. */
  taskId?: string;
};
export type SidebarDock = "bottom" | "left" | "right";
export type SidebarColumn = {
  id: string;
  side: "right";
  panels: SidebarPanel[];
  activePanelId: string;
  height: number;
  width: number;
  /** New columns choose their browser width once the pane can be measured. */
  browserWidthPending?: true;
};
export type SidebarLayout = {
  columns: SidebarColumn[];
  mainPanelId?: string;
  dock?: SidebarDock;
  open?: boolean;
  expanded?: boolean;
  /** null inherits the shared default; absence preserves a legacy saved layout verbatim. */
  dashboardPresentationOverride?: "split" | "expanded" | null;
  /** Focus the active side panel without swapping its saved main/side placement. */
  expandedSide?: boolean;
};
