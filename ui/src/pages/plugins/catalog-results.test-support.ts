import { expect, vi } from "vitest";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import type { PluginCatalogResultsProps } from "./catalog-results.tsx";

export function plugin(
  id: string,
  overrides: {
    catalog?: Partial<PluginDiscoveryEntry["catalog"]>;
    local?: Partial<PluginDiscoveryEntry["local"]>;
  } = {},
): PluginDiscoveryEntry {
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

export function baseProps(
  overrides: Partial<PluginCatalogResultsProps> = {},
): PluginCatalogResultsProps {
  return {
    connected: true,
    result: { items: [plugin("tool")] },
    hasCurrentResult: overrides.result !== null,
    reads: { browse: null, categories: null, more: null },
    error: null,
    remoteError: null,
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
    trending: [plugin("trending")],
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

export function catalogProbe(root: ParentNode) {
  return {
    node: (selector: string) => expect(root.querySelector(selector)),
    content: (selector: string) => expect(root.querySelector(selector)?.textContent),
    all: (selector: string) => expect(root.querySelectorAll(selector)),
  };
}
