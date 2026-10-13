/* @vitest-environment jsdom */

import { flush, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import {
  renderPluginCatalogResults as PluginCatalogResults,
  type PluginCatalogResultsProps,
} from "./catalog-results.tsx";

function plugin(
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
    trending: [plugin("trending")],
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

const updates = new WeakMap<HTMLElement, (props: PluginCatalogResultsProps) => void>();
function mount(props: PluginCatalogResultsProps): HTMLElement {
  const [current, setCurrent] = createSignal(props);
  const view = mountSolid(() => <PluginCatalogResults {...current()} />);
  updates.set(view.container, (next) => {
    setCurrent(next);
    flush();
  });
  flush();
  return view.container;
}
function update(container: HTMLElement, props: PluginCatalogResultsProps) {
  updates.get(container)!(props);
}

describe("renderPluginCatalogResults", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    cleanupSolid();
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
    update(container, { ...props, categoriesLoading: false });
    expect(chips.querySelector(".plugin-catalog-chip--skeleton")).toBeNull();
    expect(chips.querySelectorAll("button")).toHaveLength(3);
  });

  it("uses the package fallback for unknown and inherited category icon names", () => {
    const container = mount(
      baseProps({
        categories: ["constructor", "unknown-icon", "package", "brain"].map((icon, order) => ({
          slug: icon,
          label: icon,
          description: icon,
          icon,
          order,
        })),
      }),
    );
    const categoryIcons = [...container.querySelectorAll(".plugin-catalog-chip")]
      .slice(3)
      .map((chip) => chip.querySelector("svg")?.outerHTML);
    expect(categoryIcons[2]).toBeDefined();
    expect(categoryIcons[0]).toBe(categoryIcons[2]);
    expect(categoryIcons[1]).toBe(categoryIcons[2]);
    expect(categoryIcons[3]).toBeDefined();
    expect(categoryIcons[3]).not.toBe(categoryIcons[2]);
  });

  it.each(["official", "community", "empty", "mixed"] as const)(
    "preserves search ranking and groups only mixed publishers (%s)",
    (kind) => {
      const official = Array.from({ length: kind === "mixed" ? 10 : 1 }, (_, i) =>
        plugin(`official-${i}`),
      );
      const community = ["community-first", "community-second"].map((id) =>
        plugin(id, { catalog: { name: "OpenClaw integration", official: false, categories: [] } }),
      );
      const items =
        kind === "mixed"
          ? [community[0]!, ...official, community[1]!]
          : kind === "official"
            ? official
            : kind === "community"
              ? community.slice(0, 1)
              : [];
      const onLoadMore = vi.fn();
      const container = mount(
        baseProps({
          query: "integration",
          result: { items, ...(kind === "mixed" ? { nextCursor: "catalog-page-2" } : {}) },
          onLoadMore,
        }),
      );
      const sections = [...container.querySelectorAll(".plugin-catalog-section")];
      expect(sections.map((section) => section.querySelector("h2")?.textContent?.trim())).toEqual(
        kind === "mixed" ? ["Official", "Community"] : [],
      );
      if (kind === "mixed") {
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
      } else {
        expect(
          container.querySelectorAll(".plugin-catalog-grid--results .plugin-catalog-card"),
        ).toHaveLength(kind === "empty" ? 0 : 1);
        expect(container.querySelector("openclaw-panel-empty-state") !== null).toBe(
          kind === "empty",
        );
        expect(container.querySelector(".plugin-catalog-pagination")).toBeNull();
      }
    },
  );

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

  it("uses only resolved artwork, preferring installed icons and whitening only official images", () => {
    const imageUrl = "https://example.com/icon.png";
    const cases = [
      { id: "official-package", packageName: "@openclaw/whatsapp", official: true },
      {
        id: "community-package",
        packageName: "@community/whatsapp",
        pluginId: "whatsapp",
        official: true,
      },
      {
        id: "installed",
        pluginId: "installed",
        official: true,
        imageUrl,
        expected: "blob:package-icon",
      },
      { id: "official", official: true, imageUrl, expected: "blob:catalog-icon" },
      { id: "community", official: false, imageUrl, expected: "blob:catalog-icon" },
      { id: "missing", official: true },
    ];
    const container = mount(
      baseProps({
        query: "artwork",
        result: {
          items: cases.map(({ id, packageName, pluginId, official, imageUrl: catalogImageUrl }) =>
            plugin(id, {
              catalog: {
                name: id,
                categories: ["channels"],
                packageName,
                official,
                imageUrl: catalogImageUrl,
              },
              local: {
                pluginId,
                ...(id === "installed"
                  ? {
                      present: true,
                      installed: true,
                      enabled: true,
                      state: "enabled",
                      action: "manage",
                    }
                  : {}),
              },
            }),
          ),
        },
        pluginIconUrls: { installed: "blob:package-icon" },
        iconUrls: { [imageUrl]: "blob:catalog-icon" },
      }),
    );
    for (const { id, official, expected } of cases) {
      const art = container.querySelector(`[data-plugin-id="${id}"] .plugin-catalog-card__art`)!;
      expect(art.querySelector("img")?.getAttribute("src") ?? null).toBe(expected ?? null);
      expect(art.querySelector(".plugins-tile--white") !== null).toBe(
        official && Boolean(expected),
      );
    }
  });

  it.each([
    {
      name: "hidden catch-all categories",
      categories: ["tools", "other"],
      entries: [
        ["matched", ["tools"]],
        ["other-plugin", ["other"]],
        ["uncategorized-plugin", []],
      ],
      shelves: { tools: ["matched"], other: [], uncategorized: [] },
    },
    {
      name: "providers with multiple purposes",
      categories: ["models", "media"],
      entries: [
        ["novita", ["models", "media"]],
        ["zai", ["models", "media"]],
        ["text-only", ["models"]],
      ],
      shelves: { models: ["novita", "text-only", "zai"], media: ["novita", "zai"] },
    },
  ] satisfies Array<{
    name: string;
    categories: string[];
    entries: Array<[string, string[]]>;
    shelves: Record<string, string[]>;
  }>)(
    "keeps category membership and search consistent for $name",
    ({ categories, entries, shelves }) => {
      const props = baseProps({
        featured: [],
        trending: [],
        categories: categories.map((slug, order) => ({
          slug,
          label: slug === "other" ? "Other" : slug,
          description: slug,
          icon: "package",
          order,
        })),
        result: {
          items: entries.map(([id, entryCategories]) =>
            plugin(id, {
              catalog: {
                name: id,
                official: entryCategories.includes("models") || id === "matched",
                categories: entryCategories,
              },
            }),
          ),
        },
      });
      const container = mount(props);
      for (const [shelf, ids] of Object.entries(shelves)) {
        const section = container.querySelector(`[data-catalog-section="${shelf}"]`);
        expect(
          [...(section?.querySelectorAll<HTMLElement>(".plugin-catalog-card") ?? [])].map(
            (card) => card.dataset.pluginId,
          ),
        ).toEqual(ids);
        if (ids.length === 0) {
          expect(section).toBeNull();
        }
      }
      if (categories.includes("other")) {
        expect(
          [...container.querySelectorAll(".plugin-catalog-chip")].map((chip) =>
            chip.textContent?.trim(),
          ),
        ).not.toContain("Other");
        expect(container.querySelector('[data-plugin-id="matched"]')).not.toBeNull();
        expect(container.querySelector('[data-plugin-id="other-plugin"]')).toBeNull();
        update(container, { ...props, query: "plugin" });
        for (const id of ["other-plugin", "uncategorized-plugin"]) {
          expect(container.querySelector(`[data-plugin-id="${id}"]`)).not.toBeNull();
        }
      }
    },
  );

  it("orders and caps each category before opening its full results", () => {
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
    const onCategoryChange = vi.fn();
    const container = mount(baseProps({ result: { items: [...items, pinned] }, onCategoryChange }));
    const tools = container.querySelector('[data-catalog-section="tools"]')!;
    expect(tools.querySelectorAll(".plugin-catalog-card")).toHaveLength(8);
    expect(tools.classList.contains("plugin-catalog-section--expandable")).toBe(true);
    tools.querySelector<HTMLButtonElement>(".plugin-catalog-section__view-all")!.click();
    expect(onCategoryChange).toHaveBeenCalledWith("tools");
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

  it("keeps one action per card while an install publishes before its final response", () => {
    const installed = plugin("installed", {
      local: { present: true, installed: true, enabled: true, state: "enabled", action: "manage" },
    });
    const props = baseProps({
      query: "result",
      result: { items: [installed, plugin("available")] },
    });
    const container = mount({
      ...props,
      installProgress: new Map([["install:installed", { startedAt: Date.now(), activities: [] }]]),
    });
    const installedCard = container.querySelector('[data-plugin-id="installed"]')!;
    const action = installedCard.querySelector("openclaw-plugin-install-action");
    flush();
    expect(action?.textContent).toContain("Installing");
    expect(installedCard.querySelector('[aria-label="Enabled"]')).toBeNull();
    action?.querySelector("button")?.click();
    expect(props.onInstall).not.toHaveBeenCalled();
    update(container, props);
    expect(installedCard.querySelector("openclaw-plugin-install-action")).toBeNull();
    expect(
      installedCard.querySelector('.plugin-catalog-card__action [aria-label="Enabled"]'),
    ).not.toBeNull();
    expect(installedCard.querySelector("button")).toBeNull();
    const available = container.querySelector(
      '[data-plugin-id="available"] .plugin-catalog-card__action',
    )!;
    flush();
    expect(available.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector(".plugin-download-count")).toBeNull();
    available.querySelector<HTMLButtonElement>("button")!.click();
    expect(props.onInstall).toHaveBeenCalledWith("available");
  });
});
