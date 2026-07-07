// Control UI controller for the Workspaces dashboard: gateway state, live-update
// subscription, optimistic mutations with revert, and the minimal builtin binding
// resolver (spec-30 scope: stat-card + markdown; L4 extends the registry).
//
// Follows the workboard three-way split — this module owns all logic; the view is
// pure render fns and the page/controller is thin lifecycle glue.

import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import {
  DASHBOARD_GRID_COLUMNS,
  dashboardAgentProvenance,
  type DashboardBinding,
  type DashboardChangedEvent,
  type DashboardGridRect,
  type DashboardTab,
  type DashboardWidget,
  type DashboardWidgetRegistryEntry,
  type DashboardWidgetStatus,
  type DashboardWorkspace,
} from "./types.ts";

const CHANGED_EVENT = "plugin.dashboard.changed";

export type DashboardUiState = {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  workspace: DashboardWorkspace | null;
  /** Slug of the workspace tab in view; null until the doc resolves a default. */
  activeSlug: string | null;
  /** Whether the hidden-tabs overflow menu is open. */
  hiddenMenuOpen: boolean;
  /** Widgets with an in-flight mutation, for optimistic-state affordances. */
  pendingWidgetIds: Set<string>;
  /** Transient error surfaced after a failed mutation (reverted state + toast). */
  actionError: string | null;
  requestUpdate: (() => void) | null;
};

type DashboardHost = object;

const dashboardStates = new WeakMap<DashboardHost, DashboardUiState>();
const dashboardEventUnsubscribers = new WeakMap<DashboardHost, () => void>();
const dashboardEventClients = new WeakMap<DashboardHost, GatewayBrowserClient>();
// Per-host data-refresh polling: a single interval per host that fires the view's
// tick (re-resolve data-widget bindings) only while the document is visible.
const dashboardPollTimers = new WeakMap<DashboardHost, ReturnType<typeof setInterval>>();
const dashboardPollActive = new WeakMap<DashboardHost, boolean>();

/** Default data-refresh interval (ms); the L4 spec's 30–60s window, floored at 10s. */
export const DASHBOARD_POLL_INTERVAL_MS = 45_000;
// Per-host teardown for an in-flight hand-rolled drag: the view registers window
// pointermove/pointerup listeners while dragging, so a tab-switch/disconnect that
// calls stopDashboard must cancel the drag (remove listeners, neutralize the
// pending pointerup) rather than leak closures over the now-stale view state.
const dashboardActiveDragCancel = new WeakMap<DashboardHost, () => void>();

/**
 * Register the teardown for an active drag on `host`. The view calls this when a
 * drag begins; `cancel` must remove its window listeners and make any later
 * pointerup a no-op. A previously registered drag is cancelled first so only one
 * drag is ever live per host.
 */
export function registerActiveDrag(host: DashboardHost, cancel: () => void): void {
  dashboardActiveDragCancel.get(host)?.();
  dashboardActiveDragCancel.set(host, cancel);
}

/** Clear the active-drag teardown for `host` once the drag settles normally. */
export function clearActiveDrag(host: DashboardHost): void {
  dashboardActiveDragCancel.delete(host);
}

/** Cancel any in-flight drag on `host` (used by stopDashboard and re-registration). */
export function cancelActiveDrag(host: DashboardHost): void {
  const cancel = dashboardActiveDragCancel.get(host);
  if (cancel) {
    dashboardActiveDragCancel.delete(host);
    cancel();
  }
}

export function getDashboardState(host: DashboardHost): DashboardUiState {
  let state = dashboardStates.get(host);
  if (!state) {
    state = {
      loading: false,
      loaded: false,
      error: null,
      workspace: null,
      activeSlug: null,
      hiddenMenuOpen: false,
      pendingWidgetIds: new Set(),
      actionError: null,
      requestUpdate: null,
    };
    dashboardStates.set(host, state);
  }
  return state;
}

function notify(state: DashboardUiState): void {
  state.requestUpdate?.();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeRect(value: unknown): DashboardGridRect {
  const record = isRecord(value) ? value : {};
  const w = Math.min(DASHBOARD_GRID_COLUMNS, Math.max(1, Math.trunc(readNumber(record.w, 4))));
  const h = Math.max(1, Math.trunc(readNumber(record.h, 2)));
  const x = Math.min(DASHBOARD_GRID_COLUMNS - w, Math.max(0, Math.trunc(readNumber(record.x, 0))));
  const y = Math.max(0, Math.trunc(readNumber(record.y, 0)));
  return { x, y, w, h };
}

function normalizeBinding(value: unknown): DashboardBinding | null {
  if (!isRecord(value)) {
    return null;
  }
  const source = value.source;
  if (source !== "rpc" && source !== "file" && source !== "static") {
    return null;
  }
  return {
    source,
    ...(typeof value.method === "string" ? { method: value.method } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.pointer === "string" ? { pointer: value.pointer } : {}),
    ...(isRecord(value.params) ? { params: value.params } : {}),
    ...("value" in value ? { value: value.value } : {}),
  };
}

function normalizeBindings(value: unknown): Record<string, DashboardBinding> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const bindings: Record<string, DashboardBinding> = {};
  for (const [key, raw] of Object.entries(value)) {
    const binding = normalizeBinding(raw);
    if (binding) {
      bindings[key] = binding;
    }
  }
  return Object.keys(bindings).length ? bindings : undefined;
}

function normalizeWidget(value: unknown): DashboardWidget | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id).trim();
  const kind = readString(value.kind).trim();
  if (!id || !kind) {
    return null;
  }
  return {
    id,
    kind,
    title: readString(value.title),
    grid: normalizeRect(value.grid),
    collapsed: value.collapsed === true,
    ...(typeof value.createdBy === "string" ? { createdBy: value.createdBy } : {}),
    ...(normalizeBindings(value.bindings) ? { bindings: normalizeBindings(value.bindings) } : {}),
    ...(isRecord(value.props) ? { props: value.props } : {}),
  };
}

function normalizeTab(value: unknown): DashboardTab | null {
  if (!isRecord(value)) {
    return null;
  }
  const slug = readString(value.slug).trim();
  if (!slug) {
    return null;
  }
  const widgets = Array.isArray(value.widgets)
    ? value.widgets.map(normalizeWidget).filter((w): w is DashboardWidget => w !== null)
    : [];
  return {
    slug,
    title: readString(value.title, slug),
    hidden: value.hidden === true,
    widgets,
    ...(typeof value.icon === "string" ? { icon: value.icon } : {}),
    ...(typeof value.createdBy === "string" ? { createdBy: value.createdBy } : {}),
  };
}

const WIDGET_STATUSES = new Set<DashboardWidgetStatus>(["pending", "approved", "rejected"]);

function normalizeRegistryEntry(value: unknown): DashboardWidgetRegistryEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = value.status;
  if (typeof status !== "string" || !WIDGET_STATUSES.has(status as DashboardWidgetStatus)) {
    return null;
  }
  return {
    status: status as DashboardWidgetStatus,
    ...(typeof value.createdBy === "string" ? { createdBy: value.createdBy } : {}),
    ...(typeof value.approvedBy === "string" ? { approvedBy: value.approvedBy } : {}),
    ...(typeof value.approvedAt === "string" ? { approvedAt: value.approvedAt } : {}),
  };
}

function normalizeWidgetsRegistry(value: unknown): Record<string, DashboardWidgetRegistryEntry> {
  if (!isRecord(value)) {
    return {};
  }
  const registry: Record<string, DashboardWidgetRegistryEntry> = {};
  for (const [name, raw] of Object.entries(value)) {
    const entry = normalizeRegistryEntry(raw);
    if (entry) {
      registry[name] = entry;
    }
  }
  return registry;
}

export function normalizeWorkspace(payload: unknown): DashboardWorkspace {
  const record = isRecord(payload) ? payload : {};
  const tabs = Array.isArray(record.tabs)
    ? record.tabs.map(normalizeTab).filter((tab): tab is DashboardTab => tab !== null)
    : [];
  const prefsRecord = isRecord(record.prefs) ? record.prefs : {};
  const tabOrder = Array.isArray(prefsRecord.tabOrder)
    ? prefsRecord.tabOrder.filter((slug): slug is string => typeof slug === "string")
    : [];
  return {
    schemaVersion: readNumber(record.schemaVersion, 1),
    workspaceVersion: readNumber(record.workspaceVersion, 0),
    tabs,
    prefs: { tabOrder },
    widgetsRegistry: normalizeWidgetsRegistry(record.widgetsRegistry),
  };
}

/** The `custom:<name>` widget name, or null for builtin/unknown kinds. */
export function customWidgetName(kind: string): string | null {
  return kind.startsWith("custom:") ? kind.slice("custom:".length) || null : null;
}

/** Registry status for a custom widget kind, or null when not a tracked custom widget. */
export function customWidgetStatus(
  workspace: DashboardWorkspace,
  kind: string,
): DashboardWidgetStatus | null {
  const name = customWidgetName(kind);
  if (!name) {
    return null;
  }
  return workspace.widgetsRegistry[name]?.status ?? null;
}

/**
 * Tabs in display order: honor `prefs.tabOrder` first, then any doc-order tabs the
 * ordering omits, so a partial `tabOrder` still shows every tab.
 */
export function orderedTabs(workspace: DashboardWorkspace): DashboardTab[] {
  const bySlug = new Map(workspace.tabs.map((tab) => [tab.slug, tab]));
  const ordered: DashboardTab[] = [];
  const seen = new Set<string>();
  for (const slug of workspace.prefs.tabOrder) {
    const tab = bySlug.get(slug);
    if (tab && !seen.has(slug)) {
      ordered.push(tab);
      seen.add(slug);
    }
  }
  for (const tab of workspace.tabs) {
    if (!seen.has(tab.slug)) {
      ordered.push(tab);
      seen.add(tab.slug);
    }
  }
  return ordered;
}

export function visibleTabs(workspace: DashboardWorkspace): DashboardTab[] {
  return orderedTabs(workspace).filter((tab) => !tab.hidden);
}

export function hiddenTabs(workspace: DashboardWorkspace): DashboardTab[] {
  return orderedTabs(workspace).filter((tab) => tab.hidden);
}

export function findTab(
  workspace: DashboardWorkspace,
  slug: string | null,
): DashboardTab | undefined {
  if (!slug) {
    return undefined;
  }
  return workspace.tabs.find((tab) => tab.slug === slug);
}

/**
 * Resolve which tab is active: prefer the requested slug if it exists and is not
 * hidden; otherwise fall back to the first visible tab (or first tab of any kind).
 */
export function resolveActiveSlug(
  workspace: DashboardWorkspace,
  requested: string | null,
): string | null {
  const requestedTab = findTab(workspace, requested);
  if (requestedTab) {
    return requestedTab.slug;
  }
  const visible = visibleTabs(workspace);
  if (visible.length > 0) {
    return visible[0].slug;
  }
  return orderedTabs(workspace)[0]?.slug ?? null;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown dashboard error.";
}

/** Load the workspace document; seeds `activeSlug` from the requested deep-link slug. */
export async function loadWorkspace(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  opts?: { requestedSlug?: string | null; silent?: boolean },
): Promise<void> {
  if (!client) {
    return;
  }
  if (!opts?.silent) {
    state.loading = true;
    state.error = null;
    notify(state);
  }
  try {
    const payload = await client.request("dashboard.workspace.get", {});
    const workspace = normalizeWorkspace(
      isRecord(payload) && "workspace" in payload ? payload.workspace : payload,
    );
    state.workspace = workspace;
    state.activeSlug = resolveActiveSlug(workspace, opts?.requestedSlug ?? state.activeSlug);
    state.error = null;
    state.loaded = true;
  } catch (err) {
    state.error = formatError(err);
  } finally {
    state.loading = false;
    notify(state);
  }
}

/**
 * Subscribe to `plugin.dashboard.changed` and refetch on a newer version (skips
 * stale/own-echo events by comparing `workspaceVersion`). Push path per spec-30 —
 * the WS client surfaces event frames via `addEventListener`.
 */
export function subscribeToDashboardEvents(
  host: DashboardHost,
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
): void {
  if (!client) {
    stopDashboardEvents(host);
    return;
  }
  if (dashboardEventClients.get(host) === client) {
    return;
  }
  stopDashboardEvents(host);
  const unsubscribe = client.addEventListener((evt: GatewayEventFrame) => {
    if (evt.event !== CHANGED_EVENT) {
      return;
    }
    const payload = isRecord(evt.payload) ? (evt.payload as DashboardChangedEvent) : undefined;
    const incomingVersion = readNumber(payload?.workspaceVersion, Number.NaN);
    const currentVersion = state.workspace?.workspaceVersion ?? -1;
    // Skip our own echo / stale replays: only a strictly newer version refetches.
    if (Number.isFinite(incomingVersion) && incomingVersion <= currentVersion) {
      return;
    }
    void loadWorkspace(state, client, { silent: true });
  });
  dashboardEventUnsubscribers.set(host, unsubscribe);
  dashboardEventClients.set(host, client);
}

export function stopDashboardEvents(host: DashboardHost): void {
  dashboardEventUnsubscribers.get(host)?.();
  dashboardEventUnsubscribers.delete(host);
  dashboardEventClients.delete(host);
}

/**
 * Start (idempotently) the per-host data-refresh timer. The timer fires `onTick`
 * every `intervalMs`, but ONLY while the document is visible — a background tab
 * skips the tick so we don't hammer the gateway when nobody's watching. Passing a
 * null client stops any running timer (disconnect). A second call with a live
 * client is a no-op so re-renders don't stack timers.
 */
export function startBindingPolling(
  host: DashboardHost,
  client: GatewayBrowserClient | null,
  onTick: () => void,
  intervalMs: number = DASHBOARD_POLL_INTERVAL_MS,
): void {
  if (!client) {
    stopBindingPolling(host);
    return;
  }
  if (dashboardPollActive.get(host)) {
    return;
  }
  const clamped = Math.max(10_000, intervalMs);
  const timer = setInterval(() => {
    // Visibility gate: only refresh when the tab is foreground. On a hidden tab
    // (or SSR/no-document env) we skip; the next visible render re-resolves.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    onTick();
  }, clamped);
  dashboardPollTimers.set(host, timer);
  dashboardPollActive.set(host, true);
}

/** Stop the per-host data-refresh timer (tab-leave/disconnect). */
export function stopBindingPolling(host: DashboardHost): void {
  const timer = dashboardPollTimers.get(host);
  if (timer !== undefined) {
    clearInterval(timer);
    dashboardPollTimers.delete(host);
  }
  dashboardPollActive.delete(host);
}

/** Full lifecycle teardown for the bundled-view `stop` hook. */
export function stopDashboard(host: DashboardHost): void {
  cancelActiveDrag(host);
  stopDashboardEvents(host);
  stopBindingPolling(host);
}

function replaceWidget(
  workspace: DashboardWorkspace,
  slug: string,
  widgetId: string,
  update: (widget: DashboardWidget) => DashboardWidget,
): DashboardWorkspace {
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) =>
      tab.slug !== slug
        ? tab
        : {
            ...tab,
            widgets: tab.widgets.map((widget) =>
              widget.id === widgetId ? update(widget) : widget,
            ),
          },
    ),
  };
}

function removeWidget(
  workspace: DashboardWorkspace,
  slug: string,
  widgetId: string,
): DashboardWorkspace {
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) =>
      tab.slug !== slug
        ? tab
        : { ...tab, widgets: tab.widgets.filter((widget) => widget.id !== widgetId) },
    ),
  };
}

/**
 * Run an optimistic mutation: apply `optimistic` locally, fire the RPC, and revert
 * to the pre-mutation snapshot on failure (surfacing `actionError` for a toast).
 * All shell mutations funnel through here so revert semantics stay consistent.
 */
async function optimisticMutation(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  params: {
    widgetId: string;
    optimistic: (workspace: DashboardWorkspace) => DashboardWorkspace;
    method: string;
    rpcParams: Record<string, unknown>;
  },
): Promise<void> {
  if (!client || !state.workspace) {
    return;
  }
  const previous = state.workspace;
  const optimistic = params.optimistic(previous);
  state.workspace = optimistic;
  state.pendingWidgetIds.add(params.widgetId);
  state.actionError = null;
  notify(state);
  try {
    await client.request(params.method, params.rpcParams);
  } catch (err) {
    // Revert ONLY if we are still showing the exact optimistic doc we installed.
    // A concurrent loadWorkspace (e.g. a plugin.dashboard.changed refetch) may
    // have landed a FRESHER doc while the RPC was in flight; reverting to the
    // stale pre-mutation snapshot in that case would stomp the fresher state.
    if (state.workspace === optimistic) {
      state.workspace = previous;
    }
    state.actionError = formatError(err);
  } finally {
    state.pendingWidgetIds.delete(params.widgetId);
    notify(state);
  }
}

export function moveWidget(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string; grid: DashboardGridRect },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "dashboard.widget.move",
    rpcParams: { tab: params.slug, id: params.widgetId, grid: params.grid },
    optimistic: (workspace) =>
      replaceWidget(workspace, params.slug, params.widgetId, (widget) => ({
        ...widget,
        grid: params.grid,
      })),
  });
}

export function setWidgetCollapsed(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string; collapsed: boolean },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "dashboard.widget.update",
    rpcParams: { tab: params.slug, id: params.widgetId, patch: { collapsed: params.collapsed } },
    optimistic: (workspace) =>
      replaceWidget(workspace, params.slug, params.widgetId, (widget) => ({
        ...widget,
        collapsed: params.collapsed,
      })),
  });
}

export function updateWidgetTitle(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string; title: string },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "dashboard.widget.update",
    rpcParams: { tab: params.slug, id: params.widgetId, patch: { title: params.title } },
    optimistic: (workspace) =>
      replaceWidget(workspace, params.slug, params.widgetId, (widget) => ({
        ...widget,
        title: params.title,
      })),
  });
}

export function hideWidget(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "dashboard.widget.update",
    rpcParams: { tab: params.slug, id: params.widgetId, patch: { hidden: true } },
    optimistic: (workspace) => removeWidget(workspace, params.slug, params.widgetId),
  });
}

export function removeWidgetFromTab(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "dashboard.widget.remove",
    rpcParams: { tab: params.slug, id: params.widgetId },
    optimistic: (workspace) => removeWidget(workspace, params.slug, params.widgetId),
  });
}

export function moveWidgetToTab(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  params: { fromSlug: string; toSlug: string; widgetId: string },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "dashboard.widget.move",
    rpcParams: { tab: params.fromSlug, id: params.widgetId, toTab: params.toSlug },
    optimistic: (workspace) => {
      const source = workspace.tabs.find((tab) => tab.slug === params.fromSlug);
      const widget = source?.widgets.find((w) => w.id === params.widgetId);
      if (!widget) {
        return workspace;
      }
      return {
        ...workspace,
        tabs: workspace.tabs.map((tab) => {
          if (tab.slug === params.fromSlug) {
            return { ...tab, widgets: tab.widgets.filter((w) => w.id !== params.widgetId) };
          }
          if (tab.slug === params.toSlug) {
            return { ...tab, widgets: [...tab.widgets, widget] };
          }
          return tab;
        }),
      };
    },
  });
}

/**
 * Approve or reject a pending custom widget (operator-only) → `dashboard.widget.approve`
 * (WRITE). The registry is not part of the optimistic widget model, so this fires
 * the RPC and lets the resulting `plugin.dashboard.changed` broadcast refetch the
 * new status; a failure surfaces `actionError` for the toast.
 */
export async function approveWidget(
  state: DashboardUiState,
  client: GatewayBrowserClient | null,
  params: { name: string; decision: "approved" | "rejected" },
): Promise<void> {
  if (!client) {
    return;
  }
  state.actionError = null;
  notify(state);
  try {
    await client.request("dashboard.widget.approve", {
      name: params.name,
      decision: params.decision,
    });
  } catch (err) {
    state.actionError = formatError(err);
    notify(state);
  }
}

// --- Minimal builtin binding resolution (spec-30 scope; L4 extends) ----------

export type DashboardBindingResult = { value: unknown } | { error: string };

/**
 * Resolve a widget binding into a value the builtin renderers consume. Wire is:
 * - `static`: literal value from the binding.
 * - `rpc`: resolved CLIENT-SIDE on the page's own gateway client (00 §3 amendment).
 * - `file`: served by `dashboard.data.read`; the JSON pointer is applied here.
 *
 * `dashboard.data.read` serves file/static only and answers rpc bindings with
 * `{ code: "binding_client_resolved" }`, so rpc never routes through it.
 */
export async function resolveBinding(
  client: GatewayBrowserClient | null,
  binding: DashboardBinding,
): Promise<DashboardBindingResult> {
  try {
    if (binding.source === "static") {
      return { value: binding.value };
    }
    if (!client) {
      return { error: "Not connected." };
    }
    if (binding.source === "rpc") {
      if (!binding.method) {
        return { error: "Binding is missing an rpc method." };
      }
      const value = await client.request(binding.method, binding.params ?? {});
      return { value: applyPointer(value, binding.pointer) };
    }
    // file: `dashboard.data.read` accepts ONLY a `binding` param (its readParams
    // whitelist rejects anything else), and it resolves the file AND applies the
    // JSON pointer server-side, returning the final value under `data`. So we send
    // the whole binding and must NOT re-apply the pointer here (that would
    // double-resolve it).
    const payload = await client.request("dashboard.data.read", { binding });
    return { value: isRecord(payload) && "data" in payload ? payload.data : payload };
  } catch (err) {
    return { error: formatError(err) };
  }
}

/** Apply a JSON pointer (RFC 6901 subset) to a value; returns the value if empty. */
export function applyPointer(value: unknown, pointer: string | undefined): unknown {
  if (!pointer) {
    return value;
  }
  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export { dashboardAgentProvenance };
