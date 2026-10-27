/* @vitest-environment jsdom */

import { flush, createSignal, onSettled } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryCategory,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { baseProps, plugin, catalogProbe } from "./catalog-results.test-support.ts";
import {
  formatCompactCount,
  renderPluginCatalogResults as PluginCatalogResults,
  type PluginCatalogResultsProps,
} from "./catalog-results.tsx";
import { createPluginDiscovery } from "./plugin-discovery.ts";

const updates = new WeakMap<HTMLElement, (props: PluginCatalogResultsProps) => void>();
async function mount(props: PluginCatalogResultsProps) {
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
  return { container: view.container, ui: catalogProbe(view.container) };
}
function update(container: HTMLElement, props: PluginCatalogResultsProps) {
  updates.get(container)!(props);
}
const cardIds = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(".plugin-catalog-card")].map(
    (card) => card.dataset.pluginId,
  );

describe("renderPluginCatalogResults", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    cleanupSolid();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps first installed catalog matches current without replacing their cards", async () => {
    const installed: PluginCatalogItem = {
      id: "installed",
      name: "Installed plugin",
      catalogId: "catalog",
      kind: ["tool"],
      origin: "global",
      installed: true,
      enabled: false,
      state: "disabled",
    };
    const props = baseProps({
      intent: "featured",
      result: { items: [plugin("catalog")] },
      inventory: [
        { ...installed, installed: false, state: "not-installed" },
        installed,
        { ...installed, id: "second", enabled: true, state: "enabled" },
      ],
    });
    const { container } = await mount(props);
    const notices = container.querySelectorAll(".plugin-native-ui-disclosure");
    expect(notices).toHaveLength(1);
    const body = container.querySelector(".plugin-catalog-results__body")!;
    expect(notices[0]!.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    const card = container.querySelector('[data-plugin-id="catalog"]');
    expect(card?.querySelector("[data-plugin-state]")?.getAttribute("data-plugin-state")).toBe(
      "disabled",
    );

    update(container, { ...props, inventory: [{ ...installed, enabled: true, state: "enabled" }] });
    await waitForSolid(() =>
      expect(card?.querySelector("[data-plugin-state]")?.getAttribute("data-plugin-state")).toBe(
        "enabled",
      ),
    );
    expect(container.querySelector('[data-plugin-id="catalog"]')).toBe(card);

    update(container, { ...props, inventory: [] });
    await waitForSolid(() =>
      expect(card?.querySelector(".plugin-catalog-card__install")).not.toBeNull(),
    );
    expect(card?.querySelector("[data-plugin-state]")).toBeNull();
    expect(container.querySelector('[data-plugin-id="catalog"]')).toBe(card);
  });

  it("shows placeholders when the first browse starts after the initial render", async () => {
    const props = baseProps({ result: null, featured: [], trending: [] });
    const { container, ui } = await mount(props);
    ui.node("openclaw-panel-empty-state").not.toBeNull();
    update(container, { ...props, remoteError: "ClawHub unavailable" });
    ui.content(".callout.warning").toContain("ClawHub unavailable");
    ui.node("openclaw-panel-empty-state").toBeNull();
    container.querySelector<HTMLButtonElement>(".callout.warning button")!.click();
    expect(props.onRetry).toHaveBeenCalledOnce();

    const pending = Promise.withResolvers<null>();
    const reads = { ...props.reads, browse: pending.promise };
    update(container, { ...props, reads });
    await waitForSolid(() => {
      ui.node(".plugin-catalog-grid--skeleton").not.toBeNull();
      ui.node("openclaw-panel-empty-state").toBeNull();
    });

    update(container, { ...props, reads, result: { items: [plugin("tool")] } });
    pending.resolve(null);
    await waitForSolid(() => {
      ui.node(".plugin-catalog-grid--skeleton").toBeNull();
      ui.node('[data-plugin-id="tool"]').not.toBeNull();
    });
  });

  it("retains grouped overview cards when a refresh fails", async () => {
    const props = baseProps();
    const { container, ui } = await mount(props);
    const cards = [...container.querySelectorAll(".plugin-catalog-card")];
    expect(cards).toHaveLength(3);
    const pending = Promise.withResolvers<{ error: unknown } | null>();
    const reads = { ...props.reads, browse: pending.promise };
    update(container, { ...props, reads });
    await waitForSolid(() => ui.all(".plugin-catalog-card").toHaveLength(3));
    for (const [index, card] of cards.entries()) {
      expect(container.querySelectorAll(".plugin-catalog-card")[index]).toBe(card);
    }

    const error = new Error("Overview refresh unavailable");
    update(container, { ...props, reads, error: error.message });
    pending.resolve({ error });
    await waitForSolid(() => ui.content('[role="alert"]').toContain(error.message));
    for (const [index, card] of cards.entries()) {
      expect(container.querySelectorAll(".plugin-catalog-card")[index]).toBe(card);
    }
    ui.all(".plugin-catalog-card").toHaveLength(3);
  });

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
    const ui = catalogProbe(container);
    const retry = () =>
      container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    const more = () =>
      container.querySelector<HTMLButtonElement>(".plugin-catalog-load-more button")!;
    await waitForSolid(() => ui.node(".plugin-catalog-grid--skeleton").not.toBeNull());
    const search = container.querySelector("input")!;
    ui.all(".plugin-catalog-chip").toHaveLength(3);
    categories[0]!.reject(new Error("Categories unavailable"));
    await waitForSolid(() => ui.content('[role="alert"]').toContain("Categories unavailable"));
    ui.all(".plugin-catalog-chip").toHaveLength(3);
    ui.node("input").toBe(search);
    retry();
    await waitForSolid(() => {
      ui.node(".plugin-catalog-chip--skeleton").not.toBeNull();
      ui.node('[role="alert"]').toBeNull();
    });
    categories[1]!.resolve({ categories: [...baseProps().categories] });
    await waitForSolid(() => ui.node(".plugin-catalog-chip--skeleton").toBeNull());
    ui.node(".plugin-catalog-grid--skeleton").not.toBeNull();
    reads[0]!.reject(new Error("Catalog unavailable"));
    await waitForSolid(() => ui.content('[role="alert"]').toContain("Catalog unavailable"));
    retry();
    await waitForSolid(() => {
      ui.node(".plugin-catalog-grid--skeleton").not.toBeNull();
      ui.node('[role="alert"]').toBeNull();
    });
    reads[1]!.resolve({ items: [plugin("tool")], nextCursor: "page-2" });
    await waitForSolid(() => ui.node('[data-plugin-id="tool"]').not.toBeNull());
    const card = container.querySelector('[data-plugin-id="tool"]');
    const refreshing = discovery.refresh();
    ui.node('[data-plugin-id="tool"]').toBe(card);
    ui.node(".plugin-catalog-grid--skeleton").toBeNull();
    reads[2]!.resolve({
      items: [plugin("tool", { catalog: { name: "Updated tool" } })],
      nextCursor: "page-2",
    });
    await refreshing;
    await waitForSolid(() => expect(card?.textContent).toContain("Updated tool"));
    more().click();
    await waitForSolid(() => expect(more().disabled).toBe(true));
    ui.node('[data-plugin-id="tool"]').toBe(card);
    reads[3]!.reject(new Error("Pagination unavailable"));
    await waitForSolid(() => ui.content('[role="alert"]').toContain("Pagination unavailable"));
    retry();
    await waitForSolid(() => {
      expect(more().disabled).toBe(true);
      ui.node('[role="alert"]').toBeNull();
    });
    ui.node('[data-plugin-id="tool"]').toBe(card);
    reads[4]!.resolve({ items: [plugin("second")] });
    await waitForSolid(() => ui.node('[data-plugin-id="second"]').not.toBeNull());
    ui.node('[data-plugin-id="tool"]').toBe(card);
    ui.node("input").toBe(search);
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
    const { container, ui } = await mount(props);
    const row = container.querySelector('[data-plugin-id="audit-0"]');
    const search = container.querySelector<HTMLInputElement>("input")!;
    search.focus();
    search.setSelectionRange(0, 0);
    categoryReads = 0;
    update(container, { ...props, remoteError: "Registry temporarily unavailable" });
    expect(container.textContent).toContain("Registry temporarily unavailable");
    ui.node('[data-plugin-id="audit-0"]').toBe(row);
    ui.node("input").toBe(search);
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
    ui.node('[data-plugin-id="audit-0"]').toBe(row);
    expect(row?.querySelector("h3")?.textContent).toBe("Refreshed catalog entry");
    ui.content('[data-catalog-section="tools"] h2').toBe("Refreshed tools");
    ui.all(".plugin-catalog-card").toHaveLength(1);
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
      const { container, ui } = await mount(props);
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
      await waitForSolid(() => ui.node(".plugin-catalog-chip--skeleton").toBeNull());
      ui.all(".plugin-catalog-chips button").toHaveLength(3);
    },
  );

  it("uses the package fallback for unknown and inherited category icon names", async () => {
    const { container } = await mount(
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
        plugin(id, { catalog: { official: false } }),
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
      const { container, ui } = await mount(
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
          expect(cardIds(sections[index]!)).toEqual(entries.map((entry) => entry.id));
        }
        const loadMore = container.querySelectorAll<HTMLButtonElement>(
          ".plugin-catalog-load-more button",
        );
        expect(loadMore).toHaveLength(1);
        loadMore[0]!.click();
        expect(onLoadMore).toHaveBeenCalledOnce();
      } else {
        ui.all(".plugin-catalog-grid--results .plugin-catalog-card").toHaveLength(
          kind === "empty" ? 0 : 1,
        );
        expect(container.querySelector("openclaw-panel-empty-state") !== null).toBe(
          kind === "empty",
        );
        ui.node(".plugin-catalog-pagination").toBeNull();
      }
    },
  );

  it("uses only resolved artwork, preferring installed icons and whitening only official images", async () => {
    const imageUrl = "https://example.com/icon.png";
    const cases = [
      plugin("official-package", { catalog: { packageName: "@openclaw/whatsapp" } }),
      plugin("community-package", {
        catalog: { packageName: "@community/whatsapp" },
        local: { pluginId: "whatsapp" },
      }),
      plugin("installed", {
        catalog: { imageUrl },
        local: {
          present: true,
          installed: true,
          enabled: true,
          state: "enabled",
          action: "manage",
          pluginId: "installed",
        },
      }),
      plugin("official", { catalog: { imageUrl } }),
      plugin("community", { catalog: { imageUrl, official: false } }),
      plugin("missing"),
    ];
    const { container } = await mount(
      baseProps({
        query: "artwork",
        result: { items: cases },
        pluginIconUrls: { installed: "blob:package-icon" },
        iconUrls: { [imageUrl]: "blob:catalog-icon" },
      }),
    );
    for (const [index, { id, catalog }] of cases.entries()) {
      const expected = [
        null,
        null,
        "blob:package-icon",
        "blob:catalog-icon",
        "blob:catalog-icon",
        null,
      ][index];
      const art = container.querySelector(`[data-plugin-id="${id}"] .plugin-catalog-card__art`)!;
      expect(art.querySelector("img")?.getAttribute("src") ?? null).toBe(expected);
      expect(art.querySelector(".plugins-tile--white") !== null).toBe(
        catalog.official && Boolean(expected),
      );
    }
  });

  it("shows multi-purpose providers in each matching category", async () => {
    const membership: Record<string, string[]> = {
      models: ["novita", "text-only", "zai"],
      media: ["novita", "zai"],
    };
    const categories = Object.keys(membership);
    const ids = [...new Set(Object.values(membership).flat())];
    const props = baseProps({
      featured: [],
      trending: [],
      categories: categories.map((slug, order) => ({
        slug,
        label: slug,
        description: slug,
        icon: "package",
        order,
      })),
      result: {
        items: ids.toReversed().map((id) =>
          plugin(id, {
            catalog: {
              categories: categories.filter((category) => membership[category]!.includes(id)),
            },
          }),
        ),
      },
    });
    const { container } = await mount(props);
    for (const [shelf, members] of Object.entries(membership)) {
      const section = container.querySelector(`[data-catalog-section="${shelf}"]`);
      expect(cardIds(section!)).toEqual(members);
    }
  });

  it("orders and caps each category before opening its full results", async () => {
    const items = Array.from({ length: 9 }, (_, index) =>
      plugin(`popular-${index}`, { catalog: { downloads: 100 - index } }),
    );
    const pinned = plugin("pin", {
      catalog: { downloads: 0, categoryRanks: { tools: 0 } },
    });
    const onCategoryChange = vi.fn();
    const { container } = await mount(
      baseProps({ result: { items: [...items, pinned] }, onCategoryChange }),
    );
    const tools = container.querySelector('[data-catalog-section="tools"]')!;
    expect(tools.querySelectorAll(".plugin-catalog-card")).toHaveLength(8);
    expect(tools.classList.contains("plugin-catalog-section--expandable")).toBe(true);
    tools.querySelector<HTMLButtonElement>(".plugin-catalog-section__view-all")!.click();
    expect(onCategoryChange).toHaveBeenCalledWith("tools");
    expect(cardIds(tools)).toEqual(["pin", ...items.slice(0, 7).map((item) => item.id)]);
  });
});

describe("formatCompactCount", () => {
  it.each([
    [999, "999"],
    [1_500, "1.5k"],
    [99_960, "100k"],
    [150_400, "150k"],
    [999_499, "999k"],
    [999_500, "1m"],
    [2_500_000, "2.5m"],
    [999_499_999, "999m"],
    [999_500_000, "1b"],
    [2_500_000_000, "2.5b"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatCompactCount(value)).toBe(expected);
  });
});
