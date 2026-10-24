/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../api/gateway.ts";
import type {
  ControlUiContributions,
  ControlUiRegistration,
} from "../plugins/control-ui-capability.ts";
import "../plugins/control-ui-contributions.solid.tsx";
import { selectSidebarView } from "../test-helpers/app-sidebar-setup.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";

const dailyKey = "plugin:briefing/daily";
const fleetKey = "plugin:fleet/overview";

function pageRow(sidebar: SidebarLifecycleState, key: string) {
  return sidebar.querySelector<HTMLElement>(`.sidebar-pages [data-sidebar-entry="${key}"]`);
}

function pageEntry(sidebar: SidebarLifecycleState, key: string) {
  const row = pageRow(sidebar, key);
  if (!row) {
    throw new Error("Missing sidebar page: " + key);
  }
  const link = row.querySelector<HTMLAnchorElement>("a");
  const icon = row.querySelector<SVGSVGElement>("svg");
  const label = row.querySelector<HTMLElement>(".nav-item__text");
  if (!link || !icon || !label) {
    throw new Error("Incomplete sidebar page: " + key);
  }
  return { row, link, icon, label };
}

async function fixture() {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  const sessions = createSessionsHarness("main", ["agent:main:main"]);
  const context = createContext(gateway.gateway, sessions.sessions);
  let tab: GatewayControlUiPluginTab = {
    pluginId: "briefing",
    id: "daily",
    label: "Daily work briefing",
    icon: "fileText",
  };
  const publishTab = (patch: Partial<GatewayControlUiPluginTab> = {}) => {
    tab = { ...tab, ...patch };
    gateway.publish({ hello: { ...gateway.gateway.snapshot.hello!, controlUiTabs: [tab] } });
  };
  publishTab();
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const openPage = vi.fn();
  // This external registry fixture exposes only navigation, the host service used by these links.
  const host = {
    navigation: { pageHref: () => "/plugin/fleet/overview", openPage },
  } as unknown as ControlUiHost;
  const fleet: ControlUiRegistration<ControlUiContributions["navigation"]> = {
    key: "fleet/overview",
    pluginId: "fleet",
    value: { id: "overview", label: "OpenClaw Fleet", icon: "server", page: { id: "overview" } },
    host,
    signal: abort.signal,
  };
  const registrations: {
    [K in keyof ControlUiContributions]: ControlUiRegistration<ControlUiContributions[K]>[];
  } = {
    pages: [],
    navigation: [fleet],
    panels: [],
    actions: [],
    accessories: [],
    widgets: [],
    inlineViews: [],
    replacements: [],
  };
  const plugins = Object.assign(context.plugins, {
    revision: 0,
    registryStatus: "complete",
    registrations: <K extends keyof ControlUiContributions>(kind: K) =>
      registrations[kind].map((entry) => ({ ...entry })),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const notifyPlugins = () => {
    plugins.revision += 1;
    listeners.forEach((listener) => listener());
  };
  const { sidebar, provider } = await mountSidebarContext(context);
  sidebar.activeRouteId = "plugin";
  sidebar.activePluginTabId = "briefing/daily";
  await selectSidebarView(sidebar, "pages");
  await vi.waitFor(() => expect(pageRow(sidebar, "route:usage")).not.toBeNull());
  await settleLitElement(sidebar);
  return {
    sidebar,
    provider,
    sessions,
    publishTab,
    notifyPlugins,
    registrations,
    fleet,
    listeners,
    openPage,
  };
}

describe("Pages navigation identity", () => {
  it.each(["revision", "session", "registry", "hello"] as const)(
    "retains page rows, icons and keyboard focus across a %s update",
    async (update) => {
      const { sidebar, sessions, publishTab, notifyPlugins } = await fixture();
      const keys = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          '.sidebar-pages [data-sidebar-entry^="route:"], .sidebar-pages [data-sidebar-entry^="plugin:"]',
        ),
        (row) => row.dataset.sidebarEntry!,
      );
      expect(keys).toEqual(expect.arrayContaining(["route:usage", dailyKey, fleetKey]));
      const before = keys.map((key) => ({ key, entry: pageEntry(sidebar, key) }));
      const usage = pageEntry(sidebar, "route:usage");
      usage.link.focus();
      expect(document.activeElement).toBe(usage.link);
      if (update === "revision") {
        sidebar.invalidate();
      } else if (update === "session") {
        const result = sessions.sessions.state.result!;
        sessions.publish({
          result: {
            ...result,
            sessions: result.sessions.map((row) =>
              Object.assign({}, row, { updatedAt: row.updatedAt! + 1 }),
            ),
          },
        });
      } else if (update === "registry") {
        notifyPlugins();
      } else {
        publishTab();
      }
      await settleLitElement(sidebar);
      for (const { key, entry: previous } of before) {
        const next = pageEntry(sidebar, key);
        expect(next.row, key).toBe(previous.row);
        expect(next.link, key).toBe(previous.link);
        expect(next.icon, key).toBe(previous.icon);
        expect(next.label, key).toBe(previous.label);
      }
      expect(document.activeElement).toBe(usage.link);
      expect(pageEntry(sidebar, dailyKey).link.getAttribute("aria-current")).toBe("page");
    },
  );

  it("updates selection and availability without freezing retained links or pin actions", async () => {
    const { sidebar } = await fixture();
    const usage = pageEntry(sidebar, "route:usage");
    sidebar.activeRouteId = "usage";
    await settleLitElement(sidebar);
    expect(pageEntry(sidebar, "route:usage").link).toBe(usage.link);
    expect(usage.link.getAttribute("aria-current")).toBe("page");
    expect(usage.link.classList.contains("nav-item--active")).toBe(true);
    expect(pageEntry(sidebar, dailyKey).link.hasAttribute("aria-current")).toBe(false);
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    usage.link.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("usage", undefined);
    sidebar.sidebarEntries = [];
    sidebar.onUpdateSidebarEntries = (entries) => {
      sidebar.sidebarEntries = entries;
    };
    await settleLitElement(sidebar);
    const pin = usage.row.parentElement!.querySelector<HTMLButtonElement>(".sidebar-pages__pin")!;
    pin.click();
    await settleLitElement(sidebar);
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(pin.getAttribute("aria-label")).toContain("Unpin");
    pin.click();
    await settleLitElement(sidebar);
    expect(sidebar.sidebarEntries).toEqual([]);
    sidebar.enabledRouteIds = ["claws"];
    await settleLitElement(sidebar);
    expect(usage.row.isConnected).toBe(false);
    expect(pageRow(sidebar, "route:usage")).toBeNull();
    const claws = pageEntry(sidebar, "route:claws");
    sidebar.enabledRouteIds = ["claws", "usage"];
    await settleLitElement(sidebar);
    expect(pageEntry(sidebar, "route:claws").row).toBe(claws.row);
    expect(pageEntry(sidebar, "route:usage").link.getAttribute("aria-current")).toBe("page");
  });

  it("updates a retained plugin row when its route placement changes", async () => {
    const { sidebar, publishTab } = await fixture();
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    publishTab({ placement: "route:workboard" });
    await settleLitElement(sidebar);
    const before = pageEntry(sidebar, dailyKey);
    expect(before.link.getAttribute("href")).toBe("/workboard");
    expect(before.label.textContent).toBe("Workboard");
    before.link.click();
    expect(navigate).toHaveBeenLastCalledWith("workboard", undefined);

    publishTab({ placement: "route:worktrees" });
    await settleLitElement(sidebar);
    const after = pageEntry(sidebar, dailyKey);
    expect(after.row).toBe(before.row);
    expect(after.link.getAttribute("href")).toBe("/worktrees");
    expect(after.label.textContent).toBe("Worktrees");
    after.link.click();
    expect(navigate).toHaveBeenLastCalledWith("worktrees", undefined);
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("updates plugin artwork and labels, handles registry removal and releases subscriptions", async () => {
    const state = await fixture();
    const { sidebar } = state;
    const daily = pageEntry(sidebar, dailyKey);
    state.publishTab({ label: "Weekly work briefing", icon: "circle" });
    await settleLitElement(sidebar);
    const changed = pageEntry(sidebar, dailyKey);
    expect(changed.link).toBe(daily.link);
    expect(changed.icon).toBe(daily.icon);
    expect(changed.label).toBe(daily.label);
    expect(changed.label.textContent).toBe("Weekly work briefing");
    expect(changed.icon.querySelector("circle")?.getAttribute("r")).toBe("10");
    expect(changed.icon.querySelector("path")).toBeNull();
    state.publishTab({ icon: "square" });
    await settleLitElement(sidebar);
    expect(pageEntry(sidebar, dailyKey).icon).toBe(daily.icon);
    expect(daily.icon.querySelector("circle")).toBeNull();
    expect(daily.icon.querySelector("rect")?.getAttribute("width")).toBe("18");
    const runtime = pageEntry(sidebar, fleetKey);
    runtime.link.click();
    expect(state.openPage).toHaveBeenCalledExactlyOnceWith({ id: "overview" });
    state.registrations.navigation = [];
    state.notifyPlugins();
    await settleLitElement(sidebar);
    expect(runtime.row.isConnected).toBe(false);
    expect(pageRow(sidebar, fleetKey)).toBeNull();
    state.registrations.navigation = [state.fleet];
    state.notifyPlugins();
    await settleLitElement(sidebar);
    expect(pageEntry(sidebar, fleetKey).label.textContent).toBe("OpenClaw Fleet");
    state.provider.remove();
    await settleLitElement(sidebar);
    expect(state.listeners.size).toBe(0);
    expect(daily.row.isConnected).toBe(false);
  });
});
