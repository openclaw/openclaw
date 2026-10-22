/* @vitest-environment jsdom */

import { flush, createSignal, onSettled } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type {
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  formatCompactCount,
  renderPluginCatalogResults as PluginCatalogResults,
  type PluginCatalogResultsProps,
} from "./catalog-results.tsx";
import { createPluginDiscovery } from "./plugin-discovery.ts";

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

const updates = new WeakMap<HTMLElement, (props: PluginCatalogResultsProps) => void>();
async function mount(props: PluginCatalogResultsProps): Promise<HTMLElement> {
  const [current, setCurrent] = createSignal(props);
  const view = mountSolid(() => <PluginCatalogResults {...current()} />);
  updates.set(view.container, (next) => {
    setCurrent(next);
    flush();
  });
  flush();
  await waitForSolid(() => {
    if (!props.reads.browse) {
      expect(view.container.querySelector(".plugin-catalog-grid--skeleton")).toBeNull();
    }
    if (!props.reads.categories) {
      expect(view.container.querySelector(".plugin-catalog-chip--skeleton")).toBeNull();
    }
  });
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

  it("shows placeholders when the first browse starts after the initial render", async () => {
    const props = baseProps({ result: null, featured: [], trending: [] });
    const container = await mount(props);
    expect(container.querySelector("openclaw-panel-empty-state")).not.toBeNull();

    const pending = Promise.withResolvers<null>();
    const reads = { ...props.reads, browse: pending.promise };
    update(container, { ...props, reads });
    await waitForSolid(() => {
      expect(container.querySelector(".plugin-catalog-grid--skeleton")).not.toBeNull();
      expect(container.querySelector("openclaw-panel-empty-state")).toBeNull();
    });

    update(container, { ...props, reads, result: { items: [plugin("tool")] } });
    pending.resolve(null);
    await waitForSolid(() => {
      expect(container.querySelector(".plugin-catalog-grid--skeleton")).toBeNull();
      expect(container.querySelector('[data-plugin-id="tool"]')).not.toBeNull();
    });
  });

  it("retains grouped overview cards when a refresh fails", async () => {
    const props = baseProps();
    const container = await mount(props);
    const cards = [...container.querySelectorAll(".plugin-catalog-card")];
    expect(cards).toHaveLength(3);
    const pending = Promise.withResolvers<{ error: unknown } | null>();
    const reads = { ...props.reads, browse: pending.promise };
    update(container, { ...props, reads });
    await waitForSolid(() =>
      expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(3),
    );
    for (const [index, card] of cards.entries()) {
      expect(container.querySelectorAll(".plugin-catalog-card")[index]).toBe(card);
    }

    const error = new Error("Overview refresh unavailable");
    update(container, { ...props, reads, error: error.message });
    pending.resolve({ error });
    await waitForSolid(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(error.message),
    );
    for (const [index, card] of cards.entries()) {
      expect(container.querySelectorAll(".plugin-catalog-card")[index]).toBe(card);
    }
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(3);
  });

  it.each(["grouped", "filtered"] as const)(
    "publishes installation completion during a held %s catalog refresh",
    async (mode) => {
      const installed = plugin("installed", {
        local: {
          present: true,
          installed: true,
          enabled: true,
          state: "enabled",
          action: "manage",
        },
      });
      const props = baseProps({
        query: mode === "filtered" ? "installed" : "",
        result: { items: [installed] },
        featured: [],
        trending: [],
      });
      const progress = new Map([["install:installed", { startedAt: 1, activities: [] }]]);
      const container = await mount({ ...props, installProgress: progress });
      const card = container.querySelector('[data-plugin-id="installed"]')!;
      expect(card.querySelector("openclaw-plugin-install-action")).not.toBeNull();
      const pending = Promise.withResolvers<null>();
      const reads = { ...props.reads, browse: pending.promise };
      update(container, { ...props, reads, installProgress: progress });
      update(container, { ...props, reads });
      await waitForSolid(() => {
        expect(
          card.querySelector('.plugin-catalog-card__status[aria-label="Enabled"]'),
        ).not.toBeNull();
        expect(card.querySelector("openclaw-plugin-install-action")).toBeNull();
      });
      expect(container.querySelector('[data-plugin-id="installed"]')).toBe(card);
      pending.resolve(null);
    },
  );

  it("presents independent owner reads, retries failures, and retains cards during refresh and pagination", async () => {
    const categories = Array.from({ length: 2 }, () =>
      Promise.withResolvers<{ categories: PluginDiscoveryCategory[] }>(),
    );
    let categoryIndex = 0;
    const reads = Array.from({ length: 5 }, () => Promise.withResolvers<PluginDiscoveryResult>());
    let browseIndex = 0;
    const request = createGatewayRequestMock(async (method) =>
      method === "plugins.catalog.categories"
        ? categories[categoryIndex++]!.promise
        : reads[browseIndex++]!.promise,
    );
    const client = createTestGatewayClient(request);
    let discovery!: ReturnType<typeof createPluginDiscovery>;
    const view = mountSolid(() => {
      const [revision, changed] = createSignal(0);
      discovery = createPluginDiscovery({ getClient: () => client, isConnected: () => true }, () =>
        changed((value) => value + 1),
      );
      const props = () => {
        revision();
        return {
          ...baseProps(),
          ...discovery.read(),
          onRetry: () => void discovery.refresh(),
          onRetryCategories: () => void discovery.ensureCategories(true),
          onLoadMore: () => void discovery.loadMore(),
        };
      };
      onSettled(() => {
        void discovery.ensureCategories();
        void discovery.selectCategory("tools");
      });
      return <PluginCatalogResults {...props()} />;
    });
    const container = view.container;
    await waitForSolid(() =>
      expect(container.querySelector(".plugin-catalog-grid--skeleton")).not.toBeNull(),
    );
    const search = container.querySelector("input")!;
    expect(container.querySelectorAll(".plugin-catalog-chip")).toHaveLength(3);
    categories[0]!.reject(new Error("Categories unavailable"));
    await waitForSolid(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Categories unavailable",
      ),
    );
    expect(container.querySelectorAll(".plugin-catalog-chip")).toHaveLength(3);
    expect(container.querySelector("input")).toBe(search);
    container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForSolid(() => {
      expect(categoryIndex).toBe(2);
      expect(container.querySelector(".plugin-catalog-chip--skeleton")).not.toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
    categories[1]!.resolve({ categories: [...baseProps().categories] });
    await waitForSolid(() =>
      expect(container.querySelector(".plugin-catalog-chip--skeleton")).toBeNull(),
    );
    expect(container.querySelector(".plugin-catalog-grid--skeleton")).not.toBeNull();
    reads[0]!.reject(new Error("Catalog unavailable"));
    await waitForSolid(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Catalog unavailable",
      ),
    );
    container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForSolid(() => {
      expect(browseIndex).toBe(2);
      expect(container.querySelector(".plugin-catalog-grid--skeleton")).not.toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
    reads[1]!.resolve({ items: [plugin("tool")], nextCursor: "page-2" });
    await waitForSolid(() =>
      expect(container.querySelector('[data-plugin-id="tool"]')).not.toBeNull(),
    );
    const card = container.querySelector('[data-plugin-id="tool"]');
    const refreshing = discovery.refresh();
    await waitForSolid(() => expect(browseIndex).toBe(3));
    expect(container.querySelector('[data-plugin-id="tool"]')).toBe(card);
    expect(container.querySelector(".plugin-catalog-grid--skeleton")).toBeNull();
    reads[2]!.resolve({
      items: [plugin("tool", { catalog: { name: "Updated tool" } })],
      nextCursor: "page-2",
    });
    await refreshing;
    await waitForSolid(() => expect(card?.textContent).toContain("Updated tool"));
    container.querySelector<HTMLButtonElement>(".plugin-catalog-load-more button")!.click();
    await waitForSolid(() =>
      expect(
        container.querySelector<HTMLButtonElement>(".plugin-catalog-load-more button")?.disabled,
      ).toBe(true),
    );
    expect(container.querySelector('[data-plugin-id="tool"]')).toBe(card);
    reads[3]!.reject(new Error("Pagination unavailable"));
    await waitForSolid(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Pagination unavailable",
      ),
    );
    container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForSolid(() => {
      expect(browseIndex).toBe(5);
      expect(
        container.querySelector<HTMLButtonElement>(".plugin-catalog-load-more button")?.disabled,
      ).toBe(true);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
    expect(container.querySelector('[data-plugin-id="tool"]')).toBe(card);
    reads[4]!.resolve({ items: [plugin("second")] });
    await waitForSolid(() =>
      expect(container.querySelector('[data-plugin-id="second"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-plugin-id="tool"]')).toBe(card);
    expect(container.querySelector("input")).toBe(search);
    expect(request).toHaveBeenCalledTimes(7);
  });

  it("does not rescan the large catalog for unrelated feedback updates", async () => {
    let categoryReads = 0;
    const items = Array.from({ length: 300 }, (_, index) => {
      const entry = plugin(`audit-${index}`);
      Object.defineProperty(entry.catalog, "categories", {
        configurable: true,
        get() {
          categoryReads += 1;
          return ["tools"];
        },
      });
      return entry;
    });
    const props = baseProps({ result: { items }, featured: [], trending: [] });
    const container = await mount(props);
    const row = container.querySelector('[data-plugin-id="audit-0"]');
    const search = container.querySelector<HTMLInputElement>("input")!;
    search.focus();
    search.setSelectionRange(0, 0);
    categoryReads = 0;
    update(container, { ...props, remoteError: "Registry temporarily unavailable" });
    expect(container.textContent).toContain("Registry temporarily unavailable");
    expect(container.querySelector('[data-plugin-id="audit-0"]')).toBe(row);
    expect(container.querySelector("input")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(categoryReads).toBe(0);

    update(container, {
      ...props,
      result: {
        items: [plugin("audit-0", { catalog: { name: "Refreshed catalog entry" } })],
      },
      categories: [
        { slug: "tools", label: "Refreshed tools", description: "Tools", icon: "wrench", order: 0 },
      ],
    });
    expect(container.querySelector('[data-plugin-id="audit-0"]')).toBe(row);
    expect(row?.querySelector("h3")?.textContent).toBe("Refreshed catalog entry");
    expect(container.querySelector('[data-catalog-section="tools"] h2')?.textContent).toBe(
      "Refreshed tools",
    );
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
  });

  it.each(["initial", "delayed"] as const)(
    "keeps built-in filters usable when the category read is %s",
    async (timing) => {
      const pending = Promise.withResolvers<null>();
      const props = baseProps({
        categories: [],
        reads: {
          browse: null,
          categories: timing === "initial" ? pending.promise : null,
          more: null,
        },
      });
      const container = await mount(props);
      if (timing === "delayed") {
        update(container, { ...props, reads: { ...props.reads, categories: pending.promise } });
      }
      await waitForSolid(() => {
        const chips = container.querySelector(".plugin-catalog-chips")!;
        expect(chips.querySelectorAll("button")).toHaveLength(3);
        expect(chips.querySelectorAll(".plugin-catalog-chip--skeleton").length).toBeGreaterThan(0);
        expect(chips.querySelector('[role="status"]')).not.toBeNull();
      });
      pending.resolve(null);
      await waitForSolid(() =>
        expect(container.querySelector(".plugin-catalog-chip--skeleton")).toBeNull(),
      );
      expect(container.querySelectorAll(".plugin-catalog-chips button")).toHaveLength(3);
    },
  );

  it("uses the package fallback for unknown and inherited category icon names", async () => {
    const container = await mount(
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
    async (kind) => {
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
      const container = await mount(
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

  it("keeps a partial ClawHub failure retryable", async () => {
    const onRetry = vi.fn();
    const container = await mount(
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

  it("uses only resolved artwork, preferring installed icons and whitening only official images", async () => {
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
    const container = await mount(
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
    async ({ categories, entries, shelves }) => {
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
      const container = await mount(props);
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

  it("orders and caps each category before opening its full results", async () => {
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
    const container = await mount(
      baseProps({ result: { items: [...items, pinned] }, onCategoryChange }),
    );
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

  it("keeps one action per card while an install publishes before its final response", async () => {
    const installed = plugin("installed", {
      local: { present: true, installed: true, enabled: true, state: "enabled", action: "manage" },
    });
    const props = baseProps({
      query: "result",
      result: { items: [installed, plugin("available")] },
    });
    const container = await mount({
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

describe("formatCompactCount", () => {
  it.each([
    [999, "999"],
    [1_500, "1.5k"],
    [12_345, "12.3k"],
    [99_960, "100k"],
    [150_400, "150k"],
    [999_499, "999k"],
    [999_500, "1m"],
    [999_950, "1m"],
    [999_999, "1m"],
    [1_049_999, "1m"],
    [2_500_000, "2.5m"],
    [999_499_999, "999m"],
    [999_500_000, "1b"],
    [2_500_000_000, "2.5b"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatCompactCount(value)).toBe(expected);
  });
});
