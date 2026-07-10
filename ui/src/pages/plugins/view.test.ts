/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { PluginCatalogItem, PluginListResult } from "../../lib/plugins/index.ts";
import { CONNECTOR_SUGGESTIONS } from "./presentation.ts";
import {
  clawHubRowKey,
  connectorRowKey,
  discoverShelves,
  groupInstalledByCategory,
  installedPlugins,
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
    category: "tool",
    removable: false,
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
    activeTab: "installed",
    query: "",
    installedFilter: "all",
    searchResults: null,
    searchLoading: false,
    searchError: null,
    busy: {},
    messages: {},
    pendingRemoval: {},
    canMutate: true,
    mutationBlockedReason: null,
    pageNotice: null,
    mcpSettingsHref: "/settings/mcp",
    mcpServers: [],
    mcpMessage: null,
    mcpBusy: false,
    mcpFormOpen: false,
    onTabChange: () => undefined,
    onQueryChange: () => undefined,
    onFilterChange: () => undefined,
    onRefresh: () => undefined,
    onSetEnabled: () => undefined,
    onInstall: () => undefined,
    onRequestUninstall: () => undefined,
    onCancelUninstall: () => undefined,
    onUninstall: () => undefined,
    onAddConnector: () => undefined,
    onSearchClawHub: () => undefined,
    onMcpToggle: () => undefined,
    onMcpRemove: () => undefined,
    onMcpFormToggle: () => undefined,
    onMcpAdd: () => undefined,
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

  it("groups installed plugins by category with overview counts", () => {
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "telegram",
        name: "Telegram",
        category: "channel",
        enabled: true,
        state: "enabled",
        featured: false,
      }),
      createPlugin({
        id: "broken",
        name: "Broken",
        category: "channel",
        state: "error",
        error: "manifest invalid",
        featured: false,
      }),
    ];
    const groups = groupInstalledByCategory(installedPlugins(plugins));
    expect(groups.map((group) => group.label)).toEqual(["Channels", "Tools"]);

    const container = mount(createProps({ result: createResult(plugins) }));
    const overview = container.querySelector(".plugins-overview");
    expect(normalizedText(overview)).toContain("3 Installed");
    expect(normalizedText(overview)).toContain("1 Enabled");
    expect(normalizedText(overview)).toContain("1 Needs attention");
    expect(
      container.querySelector('[data-plugin-id="broken"] [role="alert"]')?.textContent,
    ).toContain("manifest invalid");
  });

  it("filters the installed inventory by state", () => {
    const plugins = [
      createPlugin({ id: "on", name: "On", enabled: true, state: "enabled" }),
      createPlugin({ id: "off", name: "Off" }),
      createPlugin({ id: "broken", name: "Broken", state: "error" }),
    ];
    expect(installedPlugins(plugins, "", "enabled").map((plugin) => plugin.id)).toEqual(["on"]);
    expect(installedPlugins(plugins, "", "disabled").map((plugin) => plugin.id)).toEqual(["off"]);
    expect(installedPlugins(plugins, "", "issues").map((plugin) => plugin.id)).toEqual(["broken"]);

    const onFilterChange = vi.fn();
    const container = mount(createProps({ result: createResult(plugins), onFilterChange }));
    const chips = container.querySelectorAll<HTMLButtonElement>(".plugins-filters button");
    expect(chips).toHaveLength(4);
    chips[3].click();
    expect(onFilterChange).toHaveBeenCalledWith("issues");
  });

  it("renders switches for installed rows and uninstall controls for removable rows", () => {
    const onSetEnabled = vi.fn();
    const onRequestUninstall = vi.fn();
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "community-thing",
        name: "Community Thing",
        origin: "global",
        removable: true,
        featured: false,
      }),
    ];
    const container = mount(
      createProps({ result: createResult(plugins), onSetEnabled, onRequestUninstall }),
    );

    const workboard = container.querySelector<HTMLElement>('[data-plugin-id="workboard"]');
    const workboardSwitch = workboard?.querySelector<HTMLInputElement>('[role="switch"]');
    expect(workboard?.dataset.pluginSource).toBe("bundled");
    expect(workboardSwitch?.getAttribute("aria-label")).toBe("Enable Workboard");
    expect(workboard?.querySelector(".plugins-remove")).toBeNull();

    workboardSwitch!.checked = true;
    workboardSwitch!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onSetEnabled).toHaveBeenCalledWith("workboard", true, pluginRowKey("workboard"));

    const removable = container.querySelector<HTMLElement>('[data-plugin-id="community-thing"]');
    const removeButton = removable?.querySelector<HTMLButtonElement>(".plugins-remove");
    expect(removeButton?.getAttribute("aria-label")).toBe("Remove Community Thing");
    removeButton?.click();
    expect(onRequestUninstall).toHaveBeenCalledWith(pluginRowKey("community-thing"));
  });

  it("confirms removal before uninstalling", () => {
    const onUninstall = vi.fn();
    const onCancelUninstall = vi.fn();
    const rowKey = pluginRowKey("community-thing");
    const plugins = [
      createPlugin({
        id: "community-thing",
        name: "Community Thing",
        origin: "global",
        removable: true,
        featured: false,
      }),
    ];
    const container = mount(
      createProps({
        result: createResult(plugins),
        pendingRemoval: { [rowKey]: true },
        onUninstall,
        onCancelUninstall,
      }),
    );

    const confirm = container.querySelector<HTMLElement>(".plugins-remove-confirm");
    expect(normalizedText(confirm)).toContain("Remove this plugin?");
    confirm?.querySelector<HTMLButtonElement>(".btn.danger")?.click();
    expect(onUninstall).toHaveBeenCalledWith("community-thing", rowKey);
    confirm?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    expect(onCancelUninstall).toHaveBeenCalledWith(rowKey);
  });

  it("lists MCP servers with toggle, remove, and add form callbacks", () => {
    const onMcpToggle = vi.fn();
    const onMcpRemove = vi.fn();
    const onMcpAdd = vi.fn();
    const container = mount(
      createProps({
        mcpFormOpen: true,
        mcpServers: [
          {
            name: "github",
            enabled: true,
            transport: "http",
            target: "https://api.githubcopilot.com/mcp/",
            auth: "oauth",
          },
        ],
        onMcpToggle,
        onMcpRemove,
        onMcpAdd,
      }),
    );

    const row = container.querySelector<HTMLElement>('[data-mcp-name="github"]');
    expect(normalizedText(row)).toContain("github");
    expect(normalizedText(row)).toContain("OAuth");

    const serverSwitch = row?.querySelector<HTMLInputElement>('[role="switch"]');
    serverSwitch!.checked = false;
    serverSwitch!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onMcpToggle).toHaveBeenCalledWith("github", false);

    row?.querySelector<HTMLButtonElement>(".plugins-remove")?.click();
    expect(onMcpRemove).toHaveBeenCalledWith("github");

    const form = container.querySelector<HTMLFormElement>(".plugins-mcp-form")!;
    form.querySelector<HTMLInputElement>('[name="mcp-name"]')!.value = "context7";
    form.querySelector<HTMLInputElement>('[name="mcp-target"]')!.value =
      "https://mcp.context7.com/mcp";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onMcpAdd).toHaveBeenCalledWith({
      name: "context7",
      target: "https://mcp.context7.com/mcp",
    });
  });

  it("splits discover shelves into featured, official, and connectors", () => {
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "tavily",
        name: "Tavily",
        origin: "official",
        installed: false,
        enabled: false,
        state: "not-installed",
        featured: false,
        install: { source: "official", pluginId: "tavily" },
      }),
    ];
    const shelves = discoverShelves(plugins);
    expect(shelves.featured.map((plugin) => plugin.id)).toEqual(["workboard"]);
    expect(shelves.official.map((plugin) => plugin.id)).toEqual(["tavily"]);
    expect(shelves.connectors.length).toBeGreaterThan(0);

    const onInstall = vi.fn();
    const container = mount(
      createProps({ activeTab: "discover", result: createResult(plugins), onInstall }),
    );
    expect(normalizedText(container.querySelector("#plugins-shelf-featured"))).toBe("Featured 1");
    container
      .querySelector<HTMLButtonElement>('[data-plugin-id="tavily"] .plugins-install')
      ?.click();
    expect(onInstall).toHaveBeenCalledWith(pluginRowKey("tavily"), {
      source: "official",
      pluginId: "tavily",
    });
  });

  it("adds MCP connectors and routes ClawHub connector searches", () => {
    const onAddConnector = vi.fn();
    const onSearchClawHub = vi.fn();
    const container = mount(
      createProps({ activeTab: "discover", onAddConnector, onSearchClawHub }),
    );

    const github = container.querySelector<HTMLElement>('[data-connector-id="github"]');
    expect(normalizedText(github)).toContain("MCP");
    github?.querySelector<HTMLButtonElement>(".plugins-card__footer button")?.click();
    expect(onAddConnector).toHaveBeenCalledWith(
      CONNECTOR_SUGGESTIONS.find((connector) => connector.id === "github"),
    );

    const spotify = container.querySelector<HTMLElement>('[data-connector-id="spotify"]');
    spotify?.querySelector<HTMLButtonElement>(".plugins-card__footer button")?.click();
    expect(onSearchClawHub).toHaveBeenCalledWith("spotify");
  });

  it("marks already-added MCP connectors instead of offering Add", () => {
    const onAddConnector = vi.fn();
    const container = mount(
      createProps({
        activeTab: "discover",
        mcpServers: [
          { name: "github", enabled: true, transport: "http", target: "https://x", auth: "oauth" },
        ],
        onAddConnector,
      }),
    );

    const github = container.querySelector<HTMLElement>('[data-connector-id="github"]');
    expect(normalizedText(github)).toContain("Added");
    expect(github?.querySelector(".plugins-card__footer button")).toBeNull();
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
              downloads: 149263,
              verificationTier: "source-linked",
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
    expect(normalizedText(result)).toContain("Verified source");
    expect(normalizedText(result)).toContain("149K");
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
        activeTab: "discover",
        result: createResult([createPlugin(), available]),
        canMutate: false,
        mutationBlockedReason: "Browsing only. Plugin changes require operator.admin access.",
        onInstall,
        onSetEnabled,
      }),
    );

    expect(container.querySelector(".plugins-readonly")?.textContent).toContain("operator.admin");
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
    expect(row?.querySelector("h3")?.textContent).toBe("Calendar Plus");
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
    const container = mount(createProps({ activeTab: "installed", onTabChange }));
    const installed = container.querySelector<HTMLButtonElement>("#plugins-tab-installed")!;
    const discover = container.querySelector<HTMLButtonElement>("#plugins-tab-discover")!;
    const clawhub = container.querySelector<HTMLButtonElement>("#plugins-tab-clawhub")!;

    expect([installed.tabIndex, discover.tabIndex, clawhub.tabIndex]).toEqual([0, -1, -1]);
    installed.focus();
    installed.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onTabChange).toHaveBeenLastCalledWith("discover");
    expect(document.activeElement).toBe(discover);

    discover.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(onTabChange).toHaveBeenLastCalledWith("clawhub");
    expect(document.activeElement).toBe(clawhub);
  });

  it("does not present an empty catalog alongside an initial list failure", () => {
    const container = mount(createProps({ result: null, error: "Plugin inventory unavailable" }));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Plugin inventory unavailable",
    );
    expect(container.textContent).not.toContain("No optional plugins installed");
  });

  it("renders bundled cover art in discover and gradient fallbacks elsewhere", () => {
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "totally-unknown",
        name: "Totally Unknown",
        featured: true,
        origin: "official",
        installed: false,
        state: "not-installed",
      }),
    ];
    const container = mount(createProps({ activeTab: "discover", result: createResult(plugins) }));

    const art = container.querySelector<HTMLImageElement>(
      '[data-plugin-id="workboard"] .plugins-cover img',
    );
    expect(art?.src).toContain("plugin-art/workboard.webp");

    const fallback = container.querySelector<HTMLElement>(
      '[data-plugin-id="totally-unknown"] .plugins-cover--fallback',
    );
    expect(fallback?.getAttribute("style")).toContain("--plugins-art-a");
    expect(normalizedText(fallback)).toBe("TU");
  });

  it("does not transfer a dirty switch state when an installed row disappears", () => {
    const first = createPlugin({ id: "first", name: "First" });
    const second = createPlugin({ id: "second", name: "Second", order: 20 });
    const container = mount(
      createProps({ activeTab: "installed", result: createResult([first, second]) }),
    );
    const switches = container.querySelectorAll<HTMLInputElement>('.plugins-row [role="switch"]');
    expect(switches).toHaveLength(2);
    switches[0].checked = true;

    render(
      renderPlugins(createProps({ activeTab: "installed", result: createResult([second]) })),
      container,
    );

    const remaining = container.querySelectorAll<HTMLInputElement>('.plugins-row [role="switch"]');
    expect(remaining).toHaveLength(1);
    expect(container.querySelector(".plugins-row h3")?.textContent).toBe("Second");
    expect(remaining[0].getAttribute("aria-label")).toBe("Enable Second");
    expect(remaining[0].checked).toBe(false);
  });
});
