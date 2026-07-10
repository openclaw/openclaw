/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { PluginCatalogItem, PluginListResult } from "../../lib/plugins/index.ts";
import {
  clawHubRowKey,
  groupRecommendedPlugins,
  pluginRowKey,
  renderPlugins,
  type PluginsViewProps,
} from "./view.ts";

function createPlugin(overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return {
    id: "workboard",
    name: "Workboard",
    description: "Agent work queue and session handoff.",
    version: "1.0.0",
    kind: ["productivity"],
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    featured: true,
    order: 10,
    ...overrides,
  };
}

function createResult(plugins: PluginCatalogItem[]): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

function createProps(overrides: Partial<PluginsViewProps> = {}): PluginsViewProps {
  return {
    connected: true,
    loading: false,
    result: createResult([createPlugin()]),
    error: null,
    activeTab: "recommended",
    query: "",
    searchResults: null,
    searchLoading: false,
    searchError: null,
    busy: {},
    messages: {},
    canMutate: true,
    mutationBlockedReason: null,
    onTabChange: () => undefined,
    onQueryChange: () => undefined,
    onRefresh: () => undefined,
    onSetEnabled: () => undefined,
    onInstall: () => undefined,
    ...overrides,
  };
}

function mount(props: PluginsViewProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPlugins(props), container);
  return container;
}

function normalizedText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

describe("renderPlugins", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("groups featured plugins and renders installed switches without install actions", () => {
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "lobster",
        name: "Lobster",
        kind: ["companions"],
        origin: "official",
        order: 20,
        installed: false,
        enabled: false,
        state: "not-installed",
        install: { source: "official", pluginId: "lobster" },
      }),
    ];
    const groups = groupRecommendedPlugins(plugins);
    expect(groups.map((group) => group.label)).toEqual([
      "Included with OpenClaw",
      "Official picks",
    ]);

    const onSetEnabled = vi.fn();
    const container = mount(createProps({ result: createResult(plugins), onSetEnabled }));
    const workboard = container.querySelector<HTMLElement>('[data-plugin-id="workboard"]');
    const workboardSwitch = workboard?.querySelector<HTMLInputElement>('[role="switch"]');

    expect(workboard?.dataset.pluginSource).toBe("bundled");
    expect(workboard?.dataset.pluginStatus).toBe("disabled");
    expect(normalizedText(workboard)).toContain("Included");
    expect(workboardSwitch?.getAttribute("aria-label")).toBe("Enable Workboard");
    expect(workboardSwitch?.checked).toBe(false);
    expect(workboard?.querySelector(".plugins-install")).toBeNull();

    workboardSwitch!.checked = true;
    workboardSwitch!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onSetEnabled).toHaveBeenCalledWith("workboard", true, pluginRowKey("workboard"));

    const lobsterInstall = container.querySelector<HTMLButtonElement>(
      '[data-plugin-id="lobster"] .plugins-install',
    );
    expect(lobsterInstall?.getAttribute("aria-label")).toBe("Install Lobster");
  });

  it("routes the global search, tabs, ClawHub install, and external browse link", () => {
    const onQueryChange = vi.fn();
    const onTabChange = vi.fn();
    const onInstall = vi.fn();
    const container = mount(
      createProps({
        activeTab: "clawhub",
        query: "calendar",
        searchResults: [
          {
            score: 0.9,
            package: {
              name: "@openclaw/calendar-plus",
              displayName: "Calendar Plus",
              family: "code-plugin",
              channel: "official",
              isOfficial: true,
              summary: "Plan and coordinate work.",
              latestVersion: "2.0.0",
            },
          },
        ],
        onQueryChange,
        onTabChange,
        onInstall,
      }),
    );

    const search = container.querySelector<HTMLInputElement>('[type="search"]');
    expect(search?.closest("label")?.textContent).toContain("Search plugins");
    search!.value = "work";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onQueryChange).toHaveBeenCalledWith("work");

    const installedTab = container.querySelector<HTMLButtonElement>("#plugins-tab-installed");
    expect(installedTab?.getAttribute("role")).toBe("tab");
    expect(installedTab?.tabIndex).toBe(-1);
    installedTab?.click();
    expect(onTabChange).toHaveBeenCalledWith("installed");

    const browse = container.querySelector<HTMLAnchorElement>(".plugins-clawhub-link");
    expect(browse?.href).toBe("https://clawhub.ai/plugins");
    expect(browse?.target).toBe("_blank");
    expect(browse?.rel.split(/\s+/u)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));

    const result = container.querySelector<HTMLElement>(
      '[data-package-name="@openclaw/calendar-plus"]',
    );
    expect(result?.dataset.pluginSource).toBe("clawhub");
    expect(normalizedText(result)).toContain("Official");
    expect(normalizedText(result)).toContain("Code plugin");
    result?.querySelector<HTMLButtonElement>('[aria-label="Install Calendar Plus"]')?.click();
    expect(onInstall).toHaveBeenCalledWith(clawHubRowKey("@openclaw/calendar-plus"), {
      source: "clawhub",
      packageName: "@openclaw/calendar-plus",
    });
  });

  it("keeps discovery available while disabling all read-only mutations", () => {
    const onInstall = vi.fn();
    const onSetEnabled = vi.fn();
    const available = createPlugin({
      id: "lobster",
      name: "Lobster",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "lobster" },
    });
    const container = mount(
      createProps({
        result: createResult([createPlugin(), available]),
        canMutate: false,
        mutationBlockedReason: "Browsing only. Plugin changes require operator.admin access.",
        onInstall,
        onSetEnabled,
      }),
    );

    expect(container.querySelector(".plugins-readonly")?.textContent).toContain("operator.admin");
    expect(container.querySelector<HTMLAnchorElement>(".plugins-clawhub-link")?.href).toBe(
      "https://clawhub.ai/plugins",
    );
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Install Lobster"]')?.disabled,
    ).toBe(true);
    expect(onInstall).not.toHaveBeenCalled();
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it("renders row-local risk acknowledgement and busy state", () => {
    const packageName = "@openclaw/calendar-plus";
    const key = clawHubRowKey(packageName);
    const onInstall = vi.fn();
    const container = mount(
      createProps({
        activeTab: "clawhub",
        query: "calendar",
        searchResults: [
          {
            score: 0.9,
            package: {
              name: packageName,
              displayName: "Calendar Plus",
              family: "bundle-plugin",
              channel: "community",
              isOfficial: false,
            },
          },
        ],
        busy: {},
        messages: {
          [key]: {
            kind: "error",
            text: "Review required.",
            acknowledge: { packageName, version: "2.0.0" },
          },
        },
        onInstall,
      }),
    );

    const row = container.querySelector<HTMLElement>(`[data-package-name="${packageName}"]`);
    expect(row?.getAttribute("aria-busy")).toBe("false");
    expect(row?.querySelector('[role="alert"]')?.textContent).toContain("Review required.");
    row?.querySelector<HTMLButtonElement>(".plugins-row-message button")?.click();
    expect(onInstall).toHaveBeenCalledWith(key, {
      source: "clawhub",
      packageName,
      version: "2.0.0",
      acknowledgeClawHubRisk: true,
    });
  });

  it("keeps risk acknowledgement inert when mutations become unavailable", () => {
    const packageName = "@openclaw/calendar-plus";
    const key = clawHubRowKey(packageName);
    const onInstall = vi.fn();
    const container = mount(
      createProps({
        activeTab: "clawhub",
        query: "calendar",
        canMutate: false,
        mutationBlockedReason: "Browsing only.",
        searchResults: [
          {
            score: 0.9,
            package: {
              name: packageName,
              displayName: "Calendar Plus",
              family: "code-plugin",
              channel: "community",
              isOfficial: false,
            },
          },
        ],
        messages: {
          [key]: {
            kind: "error",
            text: "Review required.",
            acknowledge: { packageName },
          },
        },
        onInstall,
      }),
    );

    const acknowledgement = container.querySelector<HTMLButtonElement>(
      ".plugins-row-message button",
    );
    expect(acknowledgement?.disabled).toBe(true);
    acknowledgement?.click();
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("correlates installed ClawHub packages without a search runtime id", () => {
    const packageName = "@community/calendar-plus";
    const installed = createPlugin({
      id: "calendar-runtime",
      name: "Calendar Plus",
      packageName,
      origin: "global",
      installed: true,
      enabled: true,
      state: "enabled",
      featured: false,
      install: undefined,
    });
    const onSetEnabled = vi.fn();
    const container = mount(
      createProps({
        activeTab: "clawhub",
        query: "calendar",
        result: createResult([installed]),
        searchResults: [
          {
            score: 0.9,
            package: {
              name: packageName,
              displayName: "Calendar Plus",
              family: "code-plugin",
              channel: "community",
              isOfficial: false,
            },
          },
        ],
        onSetEnabled,
      }),
    );

    const row = container.querySelector<HTMLElement>(`[data-package-name="${packageName}"]`);
    expect(row?.querySelector("h2")?.textContent).toBe("Calendar Plus");
    expect(row?.querySelector(".plugins-install")).toBeNull();
    row?.querySelector<HTMLInputElement>('[role="switch"]')?.click();
    expect(onSetEnabled).toHaveBeenCalledWith(
      "calendar-runtime",
      false,
      clawHubRowKey(packageName),
    );
  });

  it("uses roving focus and arrow-key activation for the catalog tabs", () => {
    const onTabChange = vi.fn();
    const container = mount(createProps({ activeTab: "recommended", onTabChange }));
    const recommended = container.querySelector<HTMLButtonElement>("#plugins-tab-recommended")!;
    const installed = container.querySelector<HTMLButtonElement>("#plugins-tab-installed")!;
    const clawhub = container.querySelector<HTMLButtonElement>("#plugins-tab-clawhub")!;

    expect([recommended.tabIndex, installed.tabIndex, clawhub.tabIndex]).toEqual([0, -1, -1]);
    recommended.focus();
    recommended.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onTabChange).toHaveBeenLastCalledWith("installed");
    expect(document.activeElement).toBe(installed);

    installed.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(onTabChange).toHaveBeenLastCalledWith("clawhub");
    expect(document.activeElement).toBe(clawhub);
  });

  it("does not present an empty catalog alongside an initial list failure", () => {
    const container = mount(createProps({ result: null, error: "Plugin inventory unavailable" }));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Plugin inventory unavailable",
    );
    expect(container.textContent).not.toContain("No recommendations yet");
  });

  it("does not transfer a dirty switch state when an installed row disappears", () => {
    const first = createPlugin({ id: "first", name: "First" });
    const second = createPlugin({ id: "second", name: "Second", order: 20 });
    const container = mount(
      createProps({ activeTab: "installed", result: createResult([first, second]) }),
    );
    const switches = container.querySelectorAll<HTMLInputElement>('[role="switch"]');
    expect(switches).toHaveLength(2);
    switches[0].checked = true;

    render(
      renderPlugins(createProps({ activeTab: "installed", result: createResult([second]) })),
      container,
    );

    const remaining = container.querySelectorAll<HTMLInputElement>('[role="switch"]');
    expect(remaining).toHaveLength(1);
    expect(container.querySelector(".plugins-card h2")?.textContent).toBe("Second");
    expect(remaining[0].getAttribute("aria-label")).toBe("Enable Second");
    expect(remaining[0].checked).toBe(false);
  });
});
