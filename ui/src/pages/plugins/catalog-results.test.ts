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
    paging: false,
    pageNumber: 1,
    canGoPrevious: false,
    canGoNext: false,
    result: { items: [plugin("tool")] },
    error: null,
    remoteError: null,
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
    categoriesError: null,
    featured: [plugin("featured")],
    featuredLoading: false,
    featuredError: null,
    trending: [plugin("trending")],
    trendingLoading: false,
    trendingError: null,
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
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn(),
    onRetry: vi.fn(),
    onRetryCategories: vi.fn(),
    onRetryFeatured: vi.fn(),
    onRetryTrending: vi.fn(),
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

  it("focuses unified search and places discovery chips before grouped sections", async () => {
    const container = mount(baseProps());
    await new Promise((resolve) => setTimeout(resolve, 40));

    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(document.activeElement).toBe(search);
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

  it("renders search as an ungrouped grid", () => {
    const container = mount(baseProps({ query: "notion", result: { items: [plugin("Notion")] } }));

    expect(container.querySelectorAll(".plugin-catalog-section")).toHaveLength(0);
    expect(
      container.querySelectorAll(".plugin-catalog-grid--results .plugin-catalog-card"),
    ).toHaveLength(1);
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
    tools?.querySelector<HTMLButtonElement>(".plugin-catalog-section__view-all")?.click();
    expect(onCategoryChange).toHaveBeenCalledWith("tools");
  });

  it("preserves every catalog result under Uncategorized when category metadata is unavailable", () => {
    const container = mount(
      baseProps({
        categories: [],
        categoriesError: "Category metadata unavailable",
        result: {
          items: Array.from({ length: 10 }, (_, index) => plugin(`catalog-result-${index}`)),
        },
      }),
    );

    expect(
      [...container.querySelectorAll<HTMLElement>("[data-catalog-section]")].map(
        (section) => section.dataset.catalogSection,
      ),
    ).toEqual(["featured", "trending", "uncategorized"]);
    const uncategorized = container.querySelector('[data-catalog-section="uncategorized"]');
    expect(uncategorized?.querySelectorAll(".plugin-catalog-card")).toHaveLength(10);
    expect(uncategorized?.querySelector(".plugin-catalog-section__view-all")).toBeNull();
  });

  it("groups only entries without a matching catalog category under Uncategorized", () => {
    const container = mount(
      baseProps({
        result: {
          items: [
            plugin("matched"),
            plugin("unmatched", {
              catalog: {
                name: "unmatched",
                official: true,
                categories: ["missing-category"],
              },
            }),
          ],
        },
      }),
    );

    const tools = container.querySelector('[data-catalog-section="tools"]');
    const uncategorized = container.querySelector('[data-catalog-section="uncategorized"]');
    expect(tools?.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
    expect(tools?.querySelector('[data-plugin-id="matched"]')).not.toBeNull();
    expect(uncategorized?.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
    expect(uncategorized?.querySelector('[data-plugin-id="unmatched"]')).not.toBeNull();
  });

  it("shows exactly one top-right status or install action and omits download counts", () => {
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
    expect(availableAction?.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector(".plugin-download-count")).toBeNull();
    availableAction?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onInstall).toHaveBeenCalledWith("available");
  });
});
