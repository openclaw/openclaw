/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { renderPluginCatalogResults, type PluginCatalogResultsProps } from "./catalog-results.ts";

function plugin(id: string, overrides: Partial<PluginDiscoveryEntry> = {}): PluginDiscoveryEntry {
  return {
    id,
    catalog: {
      name: id,
      summary: `${id} summary`,
      author: "openclaw",
      official: true,
      categories: ["tools"],
      downloads: 1_200,
      ...overrides.catalog,
    },
    local: {
      present: false,
      installed: false,
      enabled: false,
      state: "not-installed",
      action: "install",
      ...overrides.local,
    },
  };
}

function baseProps(overrides: Partial<PluginCatalogResultsProps> = {}): PluginCatalogResultsProps {
  return {
    connected: true,
    loading: false,
    result: { items: [plugin("tool")] },
    error: null,
    remoteError: null,
    categoriesLoading: false,
    categoriesError: null,
    onRetryCategories: vi.fn(),
    categories: [
      {
        slug: "channels",
        label: "Channels",
        description: "Channels",
        icon: "message-circle",
        order: 0,
      },
      { slug: "tools", label: "Tools", description: "Tools", icon: "wrench", order: 1 },
    ],
    featured: [plugin("featured")],
    featuredLoading: false,
    trending: [plugin("trending")],
    trendingLoading: false,
    loadingMore: false,
    loadMoreError: null,
    intent: "all",
    category: null,
    query: "",
    iconUrls: {},
    pluginIconUrls: {},
    canInstall: true,
    entryHref: (id) => `/plugins/${id}`,
    onIntentChange: vi.fn(),
    onCategoryChange: vi.fn(),
    onQueryChange: vi.fn(),
    onOpenEntry: vi.fn(),
    onInstall: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

function mount(props: PluginCatalogResultsProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPluginCatalogResults(props), container);
  return container;
}

describe("renderPluginCatalogResults", () => {
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

  it("keeps built-in filters usable while category placeholders settle", () => {
    const props = baseProps({ categories: [], categoriesLoading: true });
    const container = mount(props);
    const chips = container.querySelector(".plugin-catalog-chips")!;
    expect(chips.querySelectorAll("button")).toHaveLength(3);
    expect(chips.querySelectorAll(".plugin-catalog-chip--skeleton").length).toBeGreaterThan(0);
    expect(chips.querySelector('[role="status"]')).not.toBeNull();
    render(renderPluginCatalogResults({ ...props, categoriesLoading: false }), container);
    expect(chips.querySelector(".plugin-catalog-chip--skeleton")).toBeNull();
    expect(chips.querySelectorAll("button")).toHaveLength(3);
  });

  it("focuses unified search and places discovery chips before grouped sections", async () => {
    const container = mount(
      baseProps({
        result: {
          items: [
            plugin("official-tool"),
            plugin("community-tool", {
              catalog: { name: "Community tool", official: false, categories: ["tools"] },
            }),
          ],
        },
      }),
    );
    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(search));
    expect(
      [...container.querySelectorAll(".plugin-catalog-chip")].map((chip) =>
        chip.textContent?.trim(),
      ),
    ).toEqual(["All", "Featured", "Trending", "Channels", "Tools"]);
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-catalog-section]")].map(
        (section) => section.dataset.catalogSection,
      ),
    ).toEqual(["featured", "trending", "tools"]);
  });

  it.each([true, false, null])(
    "keeps search flat for one publisher type or no matches (%s)",
    (official) => {
      const container = mount(
        baseProps({
          query: "notion",
          result: {
            items:
              official === null
                ? []
                : [plugin("Notion", { catalog: { name: "Notion", official, categories: [] } })],
          },
        }),
      );

      expect(container.querySelectorAll(".plugin-catalog-section")).toHaveLength(0);
      expect(
        container.querySelectorAll(".plugin-catalog-grid--results .plugin-catalog-card"),
      ).toHaveLength(official === null ? 0 : 1);
      expect(container.querySelector("openclaw-panel-empty-state") !== null).toBe(
        official === null,
      );
      expect(container.querySelector(".plugin-catalog-pagination")).toBeNull();
    },
  );

  it("groups mixed search results by official status without truncating or changing each group's rank", () => {
    const official = Array.from({ length: 10 }, (_, index) => plugin(`official-${index}`));
    const community = ["community-first", "community-second"].map((id) =>
      plugin(id, { catalog: { name: "OpenClaw integration", official: false, categories: [] } }),
    );
    const onLoadMore = vi.fn();
    const container = mount(
      baseProps({
        query: "integration",
        result: {
          items: [community[0]!, ...official, community[1]!],
          nextCursor: "catalog-page-2",
        },
        onLoadMore,
      }),
    );

    expect(
      [...container.querySelectorAll(".plugin-catalog-section h2")].map((heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(["Official", "Community"]);
    const sections = container.querySelectorAll(".plugin-catalog-section");
    for (const [index, entries] of [official, community].entries()) {
      expect(
        [...sections[index]!.querySelectorAll<HTMLElement>(".plugin-catalog-card")].map(
          (card) => card.dataset.pluginId,
        ),
      ).toEqual(entries.map((entry) => entry.id));
    }
    const loadMore = container.querySelectorAll<HTMLButtonElement>(
      ".plugin-catalog-load-more button",
    );
    expect(loadMore).toHaveLength(1);
    loadMore[0]!.click();
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("offers bounded continuation only when the expanded result has another page", () => {
    const onLoadMore = vi.fn();
    const container = mount(
      baseProps({
        category: "tools",
        result: { items: [plugin("tool")], nextCursor: "catalog-page-2" },
        onLoadMore,
      }),
    );

    const loadMore = container.querySelector<HTMLButtonElement>(".plugin-catalog-load-more button");
    expect(loadMore?.textContent?.trim()).toBe("Load more");
    loadMore?.click();
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("keeps a partial ClawHub failure retryable", () => {
    const onRetry = vi.fn();
    const container = mount(
      baseProps({
        remoteError: "ClawHub is unavailable; local plugins remain available.",
        result: { items: [] },
        featured: [],
        trending: [],
        onRetry,
      }),
    );

    const warnings = container.querySelectorAll<HTMLElement>(".callout.warning");
    expect(warnings).toHaveLength(1);
    const warning = warnings.item(0);
    expect(warning?.textContent).toContain("ClawHub is unavailable");
    expect(container.querySelector("openclaw-panel-empty-state")).toBeNull();
    warning?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each<{
    name: string;
    packageName: string;
    pluginId: string | undefined;
    installed?: boolean;
    imageUrl?: string;
    pluginIconUrls: Record<string, string>;
    iconUrls: Record<string, string>;
    expected: string | undefined;
  }>([
    {
      name: "uninstalled first-party placeholder",
      packageName: "@openclaw/whatsapp",
      pluginId: undefined,
      pluginIconUrls: {},
      iconUrls: {},
      expected: undefined,
    },
    {
      name: "third-party identity without first-party artwork",
      packageName: "@community/whatsapp",
      pluginId: "whatsapp",
      pluginIconUrls: {},
      iconUrls: {},
      expected: undefined,
    },
    {
      name: "unscoped third-party identity without first-party artwork",
      packageName: "whatsapp",
      pluginId: "whatsapp",
      pluginIconUrls: {},
      iconUrls: {},
      expected: undefined,
    },
    {
      name: "installed package icon before catalog imagery",
      packageName: "@openclaw/whatsapp",
      pluginId: "whatsapp",
      installed: true,
      imageUrl: "https://example.com/icon.png",
      pluginIconUrls: { whatsapp: "blob:package-icon" },
      iconUrls: { "https://example.com/icon.png": "blob:catalog-icon" },
      expected: "blob:package-icon",
    },
    {
      name: "published package icon before installation",
      packageName: "@openclaw/whatsapp",
      pluginId: undefined,
      imageUrl: "https://example.com/icon.png",
      pluginIconUrls: {},
      iconUrls: { "https://example.com/icon.png": "blob:catalog-icon" },
      expected: "blob:catalog-icon",
    },
  ])(
    "renders $name",
    ({ packageName, pluginId, installed, imageUrl, pluginIconUrls, iconUrls, expected }) => {
      const entry = plugin("catalog-entry");
      const container = mount(
        baseProps({
          query: "whatsapp",
          result: {
            items: [
              {
                ...entry,
                catalog: { ...entry.catalog, packageName, imageUrl },
                local: {
                  ...entry.local,
                  pluginId,
                  installed: installed ?? false,
                  enabled: installed ?? false,
                  state: installed ? "enabled" : "not-installed",
                },
              },
            ],
          },
          pluginIconUrls,
          iconUrls,
        }),
      );

      expect(container.querySelector(".plugin-catalog-card__art img")?.getAttribute("src")).toBe(
        expected,
      );
    },
  );

  it("shows initials when a package icon cannot decode, then accepts a new icon", async () => {
    const entry = plugin("slack", {
      catalog: {
        name: "Slack",
        categories: ["channels"],
        official: true,
        imageUrl: "https://example.com/icon.png",
      },
    });
    const props = baseProps({
      query: "slack",
      result: { items: [entry] },
      iconUrls: { "https://example.com/icon.png": "blob:broken" },
    });
    const container = mount(props);
    container.querySelector(".plugin-catalog-card__art img")!.dispatchEvent(new Event("error"));
    await vi.waitFor(() =>
      expect(container.querySelector(".plugin-catalog-card__art img")).toBeNull(),
    );
    expect(
      container
        .querySelector(".plugin-catalog-card__art .plugins-tile--fallback")
        ?.textContent?.trim(),
    ).toBe("SL");
    render(renderPluginCatalogResults(props), container);
    expect(container.querySelector(".plugin-catalog-card__art img")).toBeNull();
    render(
      renderPluginCatalogResults({
        ...props,
        iconUrls: { "https://example.com/icon.png": "blob:repaired" },
      }),
      container,
    );
    expect(container.querySelector(".plugin-catalog-card__art img")?.getAttribute("src")).toBe(
      "blob:repaired",
    );
  });

  it("uses white tiles for official catalog images without styling placeholders or community icons", () => {
    const imageUrl = "https://example.com/icon.png";
    const container = mount(
      baseProps({
        result: {
          items: [
            plugin("official", {
              catalog: { name: "Official", official: true, categories: [], imageUrl },
            }),
            plugin("community", {
              catalog: { name: "Community", official: false, categories: [], imageUrl },
            }),
            plugin("missing"),
          ],
        },
        iconUrls: { [imageUrl]: "blob:icon" },
      }),
    );

    expect(
      container.querySelector(
        '.plugin-catalog-card[data-plugin-id="official"] .plugins-tile--white',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '.plugin-catalog-card[data-plugin-id="community"] .plugins-tile--white',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '.plugin-catalog-card[data-plugin-id="missing"] .plugins-tile--white',
      ),
    ).toBeNull();
  });

  it("caps grouped sections at two desktop rows and opens the selected category", () => {
    const onCategoryChange = vi.fn();
    const container = mount(
      baseProps({
        result: { items: Array.from({ length: 10 }, (_, index) => plugin(`tool-${index}`)) },
        onCategoryChange,
      }),
    );
    const tools = container.querySelector('[data-catalog-section="tools"]');

    expect(tools?.querySelectorAll(".plugin-catalog-card")).toHaveLength(8);
    expect(tools?.classList.contains("plugin-catalog-section--expandable")).toBe(true);
    tools?.querySelector<HTMLButtonElement>(".plugin-catalog-section__view-all")?.click();
    expect(onCategoryChange).toHaveBeenCalledWith("tools");
  });

  it("hides Other and Uncategorized from the homepage and category navigation while retaining search", () => {
    const other = plugin("other-plugin", {
      catalog: { name: "Other plugin", official: false, categories: ["other"] },
    });
    const uncategorized = plugin("uncategorized-plugin", {
      catalog: { name: "Uncategorized plugin", official: false, categories: [] },
    });
    const props = baseProps({
      categories: [
        ...baseProps().categories,
        { slug: "other", label: "Other", description: "Other", icon: "package", order: 99 },
      ],
      result: { items: [plugin("matched"), other, uncategorized] },
    });
    const container = mount(props);
    expect(container.querySelector('[data-catalog-section="other"]')).toBeNull();
    expect(container.querySelector('[data-catalog-section="uncategorized"]')).toBeNull();
    expect(
      [...container.querySelectorAll(".plugin-catalog-chip")].map((chip) =>
        chip.textContent?.trim(),
      ),
    ).not.toContain("Other");
    expect(container.querySelector('[data-plugin-id="matched"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-id="other-plugin"]')).toBeNull();
    render(renderPluginCatalogResults({ ...props, query: "plugin" }), container);
    expect(container.querySelector('[data-plugin-id="other-plugin"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-id="uncategorized-plugin"]')).not.toBeNull();
  });

  it("orders each category by its own pins before downloads and truncation", () => {
    const items = Array.from({ length: 9 }, (_, index) =>
      plugin(`popular-${index}`, {
        catalog: {
          name: `Popular ${index}`,
          official: index === 8,
          categories: ["tools"],
          downloads: 100 - index,
        },
      }),
    );
    const pinned = plugin("pin", {
      catalog: {
        name: "Pin",
        official: false,
        categories: ["tools", "channels"],
        downloads: 0,
        categoryRanks: { tools: 0 },
      },
    });
    const container = mount(baseProps({ result: { items: [...items, pinned] } }));
    expect(
      [
        ...container.querySelectorAll<HTMLElement>(
          '[data-catalog-section="tools"] .plugin-catalog-card',
        ),
      ].map((card) => card.dataset.pluginId),
    ).toEqual([
      "pin",
      "popular-0",
      "popular-1",
      "popular-2",
      "popular-3",
      "popular-4",
      "popular-5",
      "popular-6",
    ]);
  });

  it("shows exactly one top-right status or install action and omits download counts", async () => {
    const onInstall = vi.fn();
    const installed = plugin("installed", {
      local: {
        present: true,
        installed: true,
        enabled: true,
        state: "enabled",
        pluginId: "installed",
        action: "manage",
      },
    });
    const available = plugin("available");
    const container = mount(
      baseProps({ query: "result", result: { items: [installed, available] }, onInstall }),
    );

    const installedCard = container.querySelector('[data-plugin-id="installed"]');
    const installedAction = installedCard?.querySelector(".plugin-catalog-card__action");
    expect(installedAction?.querySelector('[aria-label="Enabled"]')).not.toBeNull();
    expect(installedCard?.querySelector("button")).toBeNull();
    const availableCard = container.querySelector('[data-plugin-id="available"]');
    const availableAction = availableCard?.querySelector(".plugin-catalog-card__action");
    await availableAction?.querySelector("openclaw-plugin-install-action")?.updateComplete;
    expect(availableAction?.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector(".plugin-download-count")).toBeNull();
    availableAction?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onInstall).toHaveBeenCalledWith("available");
  });

  it("retains install progress when the catalog publishes installed status before the final response", async () => {
    const entry = plugin("published", {
      local: { present: true, installed: true, enabled: true, state: "enabled", action: "manage" },
    });
    const props = baseProps({ query: "published", result: { items: [entry] } });
    const container = mount({
      ...props,
      installProgress: new Map([["install:published", { startedAt: Date.now(), activities: [] }]]),
    });
    const action = container.querySelector("openclaw-plugin-install-action");
    await action?.updateComplete;
    expect(action?.textContent).toContain("Installing");
    expect(container.querySelector('[aria-label="Enabled"]')).toBeNull();
    action?.querySelector("button")?.click();
    expect(props.onInstall).not.toHaveBeenCalled();
    render(renderPluginCatalogResults(props), container);
    expect(container.querySelector("openclaw-plugin-install-action")).toBeNull();
    expect(container.querySelector('[aria-label="Enabled"]')).not.toBeNull();
  });
});
