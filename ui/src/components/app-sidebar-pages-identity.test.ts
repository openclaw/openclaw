/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
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
  const row = pageRow(sidebar, key)!;
  const entry = {
    row,
    link: row.querySelector<HTMLAnchorElement>("a")!,
    icon: row.querySelector<SVGSVGElement>("svg")!,
    label: row.querySelector<HTMLElement>(".nav-item__text")!,
  };
  expect(Object.values(entry)).not.toContain(null);
  return entry;
}

function expectRetained(before: ReturnType<typeof pageEntry>, after: ReturnType<typeof pageEntry>) {
  for (const field of ["row", "link", "icon", "label"] as const) {
    expect(after[field], field).toBe(before[field]);
  }
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
      const before = ["route:usage", dailyKey, fleetKey].map((key) => ({
        key,
        entry: pageEntry(sidebar, key),
      }));
      const usage = pageEntry(sidebar, "route:usage");
      usage.link.focus();
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
        expectRetained(previous, pageEntry(sidebar, key));
      }
      expect(document.activeElement).toBe(usage.link);
      expect(pageEntry(sidebar, dailyKey).link.getAttribute("aria-current")).toBe("page");
    },
  );

  it("updates selection, locale and availability without freezing links or pin actions", async () => {
    const { sidebar } = await fixture();
    const usage = pageEntry(sidebar, "route:usage");
    sidebar.activeRouteId = "usage";
    await settleLitElement(sidebar);
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
    onTestFinished(() => i18n.setLocale("en"));
    await i18n.setLocale("de");
    await vi.waitFor(() => expect(usage.label.textContent).toBe("Nutzung"));
    sidebar.enabledRouteIds = ["templates"];
    await settleLitElement(sidebar);
    expect(pageRow(sidebar, "route:usage")).toBeNull();
    const templates = pageEntry(sidebar, "route:templates");
    sidebar.enabledRouteIds = ["templates", "usage"];
    await settleLitElement(sidebar);
    expect(pageEntry(sidebar, "route:templates").row).toBe(templates.row);
    expect(pageEntry(sidebar, "route:usage").link.getAttribute("aria-current")).toBe("page");
  });

  it("updates a retained plugin row when its route placement changes", async () => {
    const { sidebar, publishTab } = await fixture();
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    let firstRow: HTMLElement | undefined;
    for (const [route, label] of [
      ["workboard", "Workboard"],
      ["worktrees", "Worktrees"],
    ] as const) {
      publishTab({ placement: `route:${route}` });
      await settleLitElement(sidebar);
      const entry = pageEntry(sidebar, dailyKey);
      firstRow ??= entry.row;
      expect(entry.row).toBe(firstRow);
      expect(entry.link.getAttribute("href")).toBe(`/${route}`);
      expect(entry.label.textContent).toBe(label);
      entry.link.click();
      expect(navigate).toHaveBeenLastCalledWith(route, undefined);
    }
  });

  it("updates plugin artwork and labels, handles registry removal and releases subscriptions", async () => {
    const state = await fixture();
    const { sidebar } = state;
    const daily = pageEntry(sidebar, dailyKey);
    state.publishTab({ label: "Weekly work briefing", icon: "circle" });
    await settleLitElement(sidebar);
    const changed = pageEntry(sidebar, dailyKey);
    expectRetained(daily, changed);
    expect(changed.label.textContent).toBe("Weekly work briefing");
    expect(changed.icon.querySelector("circle")).not.toBeNull();
    expect(changed.icon.querySelector("path")).toBeNull();
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
