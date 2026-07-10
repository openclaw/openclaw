// Control UI dashboard types mirror the plugin `workspace.json` schema.
//
// KEEP IN SYNC: the plugin store in `extensions/dashboard/` owns the canonical
// schema (00-vision-and-architecture §1). These are the UI-side read models the
// bundled Workspaces view renders from; only the fields the shell reads are
// modelled here, and every payload is normalized defensively on load because the
// gateway boundary is untyped.

export const DASHBOARD_GRID_COLUMNS = 12;

/** Provenance stamp: who authored a tab or widget. `agent:<id>` renders a chip. */
export type DashboardCreatedBy = string;

export type DashboardWidgetKind = string;

export type DashboardBindingSource = "rpc" | "file" | "static";

export type DashboardBinding = {
  source: DashboardBindingSource;
  /** `rpc` bindings name an allowlisted read method resolved client-side. */
  method?: string;
  /** `file` bindings name a path under the plugin's data dir. */
  path?: string;
  /** JSON pointer into the resolved document. */
  pointer?: string;
  params?: Record<string, unknown>;
  /** `static` bindings carry their value inline. */
  value?: unknown;
};

export type DashboardGridRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DashboardWidget = {
  id: string;
  kind: DashboardWidgetKind;
  title: string;
  grid: DashboardGridRect;
  collapsed: boolean;
  createdBy?: DashboardCreatedBy;
  bindings?: Record<string, DashboardBinding>;
  props?: Record<string, unknown>;
};

export type DashboardTab = {
  slug: string;
  title: string;
  icon?: string;
  hidden: boolean;
  createdBy?: DashboardCreatedBy;
  widgets: DashboardWidget[];
};

export type DashboardPrefs = {
  tabOrder: string[];
};

/** Custom-widget registry status (00 §6). Only `approved` widgets get an iframe. */
export type DashboardWidgetStatus = "pending" | "approved" | "rejected";

/** UI read model of one `widgetsRegistry` entry (custom-widget approval state). */
export type DashboardWidgetRegistryEntry = {
  status: DashboardWidgetStatus;
  createdBy?: DashboardCreatedBy;
  approvedBy?: DashboardCreatedBy;
  approvedAt?: string;
};

export type DashboardWorkspace = {
  schemaVersion: number;
  workspaceVersion: number;
  tabs: DashboardTab[];
  prefs: DashboardPrefs;
  /** Custom-widget install/approval state, keyed by widget name (`custom:<name>`). */
  widgetsRegistry: Record<string, DashboardWidgetRegistryEntry>;
};

/** Capability names a custom widget may hold (00 §2). */
export type DashboardWidgetCapability = "data:read" | "prompt:send";

/**
 * The subset of a custom widget's `widget.json` manifest the parent bridge needs
 * to gate child requests: which binding ids are declared and which capabilities
 * the operator approved. Loaded on demand by the host from the served manifest.
 */
export type WidgetManifestView = {
  name: string;
  bindingIds: string[];
  capabilities: DashboardWidgetCapability[];
};

/** Payload of the `plugin.dashboard.changed` broadcast (01-conventions §Event naming). */
export type DashboardChangedEvent = {
  workspaceVersion: number;
  changedTabSlug?: string;
  actor?: string;
};

/** Provenance is an agent authorship when the stamp is prefixed `agent:`. */
export function dashboardAgentProvenance(createdBy: DashboardCreatedBy | undefined): string | null {
  if (typeof createdBy !== "string") {
    return null;
  }
  const trimmed = createdBy.trim();
  return trimmed.startsWith("agent:") ? trimmed.slice("agent:".length) || "agent" : null;
}
