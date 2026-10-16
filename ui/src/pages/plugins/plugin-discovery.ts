import { onCleanup } from "solid-js";
import { comparePluginCatalogEntries } from "../../../../packages/plugin-package-contract/src/catalog-order.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type {
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import { createPluginRequest } from "./plugin-request.ts";

export type PluginDiscoveryIntent = "all" | "bundled" | "trending" | "official" | "featured";
export type PluginDiscoveryState = {
  result: PluginDiscoveryResult | null;
  error: string | null;
  remoteError: string | null;
  categories: readonly PluginDiscoveryCategory[];
  categoriesError: string | null;
  featured: readonly PluginDiscoveryEntry[];
  trending: readonly PluginDiscoveryEntry[];
  loadMoreError: string | null;
  intent: PluginDiscoveryIntent;
  category: string | null;
  query: string;
  readonly loading: boolean;
  readonly categoriesLoading: boolean;
  readonly loadingMore: boolean;
};

const CATALOG_PAGE_SIZE = 100;
const CATALOG_SECTION_SIZE = 8;

type CatalogPageArgs = readonly [
  client: GatewayBrowserClient,
  intent: PluginDiscoveryIntent,
  category: string | null,
  query: string,
];

type CatalogPageLoad = PluginDiscoveryResult & {
  overview: boolean;
  selection: {
    intent: PluginDiscoveryIntent;
    category: string | null;
    query: string;
  };
};

type PluginDiscoveryGateway = {
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
};

function rankedOverviewShelf(
  items: readonly PluginDiscoveryEntry[],
  membership: "featured" | "trending",
): PluginDiscoveryEntry[] {
  const rank = `${membership}Rank` as const;
  return items
    .filter((item) => item.catalog[membership])
    .toSorted(
      (left, right) =>
        (left.catalog[rank] ?? Number.MAX_SAFE_INTEGER) -
        (right.catalog[rank] ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, CATALOG_SECTION_SIZE);
}

export function createPluginDiscovery(gateway: PluginDiscoveryGateway, onChange: () => void) {
  let overview: CatalogPageLoad | null = null;
  let resultSelection: CatalogPageLoad["selection"] | null = null;
  let categoriesReady = false;
  let categoriesStarted = false;
  let committedQuery = "";
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  const state: PluginDiscoveryState = {
    result: null,
    error: null,
    remoteError: null,
    categories: [],
    categoriesError: null,
    featured: [],
    trending: [],
    loadMoreError: null,
    intent: "all",
    category: null,
    query: "",
    get loading(): boolean {
      // Keep keyed cards and their open controls during a same-selection refresh.
      // New filters must wait for their own result instead of showing the old selection.
      return (
        gateway.isConnected() &&
        (state.query.trim() !== committedQuery ||
          (browseTask.pending &&
            (!state.result ||
              resultSelection?.intent !== state.intent ||
              resultSelection.category !== state.category ||
              resultSelection.query !== committedQuery)))
      );
    },
    get categoriesLoading(): boolean {
      return (
        gateway.isConnected() && categoriesStarted && !categoriesReady && categoriesTask.pending
      );
    },
    get loadingMore(): boolean {
      return gateway.isConnected() && loadMoreTask.pending;
    },
  };
  const categoriesTask = createPluginRequest(onChange, {
    task: ([client]: readonly [GatewayBrowserClient], { signal }) =>
      client.request<{ categories: PluginDiscoveryCategory[] }>(
        "plugins.catalog.categories",
        {},
        { signal },
      ),
    onComplete: ({ categories }) => {
      state.categories = categories;
      categoriesReady = true;
      state.categoriesError = null;
    },
    onError: (error) => {
      state.categoriesError = formatUiError(error);
    },
  });
  const browseTask = createPluginRequest(onChange, {
    task: (
      [client, intent, category, query, manual]: readonly [...CatalogPageArgs, manual: boolean],
      { signal },
    ) => fetchAvailablePage({ client, intent, category, query, manual, signal }),
    onComplete: applyPage,
    onError: (error) => {
      state.error = formatUiError(error);
    },
  });
  const loadMoreTask = createPluginRequest(onChange, {
    task: (
      [client, intent, category, query, cursor]: readonly [...CatalogPageArgs, cursor: string],
      { signal },
    ) => fetchAvailablePage({ client, intent, category, query, cursor, signal }),
    onComplete: (page) => {
      if (!state.result || state.result.nextCursor !== page.requestedCursor) {
        return;
      }
      const entries = new Map(state.result.items.map((item) => [item.id, item]));
      for (const item of page.items) {
        // Cursor projections replace first-page placeholders with current Gateway local state.
        entries.set(item.id, item);
      }
      const items = [...entries.values()];
      state.result = {
        items:
          state.intent === "all" && !committedQuery
            ? items.toSorted((left, right) =>
                comparePluginCatalogEntries(left, right, state.category),
              )
            : items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
      state.loadMoreError = page.remoteError ?? null;
    },
    onError: (error) => {
      state.loadMoreError = formatUiError(error);
    },
  });
  function applyPage(page: CatalogPageLoad): void {
    state.result = {
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
    resultSelection = page.selection;
    state.remoteError = page.remoteError ?? null;
    if (page.overview) {
      overview = page.remoteError ? null : page;
      // The overview is already fetched for cards. Use its canonical categories
      // if it beats the lightweight read (including older ClawHub servers that
      // cannot serve that endpoint), and retire the slower request.
      if (page.categories) {
        categoriesTask.reset();
        state.categories = page.categories;
        categoriesReady = true;
        state.categoriesError = null;
      }
      state.featured = rankedOverviewShelf(page.items, "featured");
      state.trending = rankedOverviewShelf(page.items, "trending");
    }
  }

  async function ensureCategories(retry = false): Promise<void> {
    const client = gateway.getClient();
    if (
      !client ||
      !gateway.isConnected() ||
      categoriesReady ||
      (categoriesStarted && (categoriesTask.pending || !retry))
    ) {
      return;
    }
    state.categoriesError = null;
    categoriesStarted = true;
    await categoriesTask.run([client]);
  }

  async function fetchAvailablePage(params: {
    client: GatewayBrowserClient;
    intent: PluginDiscoveryIntent;
    category: string | null;
    query: string;
    manual?: boolean;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<CatalogPageLoad & { requestedCursor?: string }> {
    const groupedOverview =
      !params.cursor && isGroupedOverview(params.intent, params.category, params.query);
    const page = await params.client.request<PluginDiscoveryResult>(
      "plugins.catalog.browse",
      {
        intent: params.intent,
        ...(params.category ? { category: params.category } : {}),
        ...(params.query ? { query: params.query } : {}),
        ...(params.manual ? { searchSource: "openclaw-control-ui" } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
        pageSize: CATALOG_PAGE_SIZE,
      },
      { signal: params.signal },
    );
    const items =
      params.intent === "all" && !params.query
        ? page.items.toSorted((left, right) =>
            comparePluginCatalogEntries(left, right, params.category),
          )
        : page.items;
    return {
      items,
      overview: groupedOverview,
      selection: { intent: params.intent, category: params.category, query: params.query },
      ...(page.categories ? { categories: page.categories } : {}),
      ...(page.nextCursor && !params.query ? { nextCursor: page.nextCursor } : {}),
      ...(page.remoteError ? { remoteError: page.remoteError } : {}),
      ...(params.cursor ? { requestedCursor: params.cursor } : {}),
    };
  }

  function isGroupedOverview(
    intent = state.intent,
    category = state.category,
    query = committedQuery,
  ): boolean {
    return intent === "all" && category === null && !query;
  }

  function invalidate(): void {
    // Reconnects reload the latest input without replaying its manual observation.
    disconnect();
    committedQuery = state.query.trim();
    state.result = null;
    resultSelection = null;
    state.categories = [];
    categoriesReady = false;
    state.categoriesError = null;
    state.error = null;
    state.remoteError = null;
    state.featured = [];
    state.trending = [];
    state.loadMoreError = null;
  }

  function disconnect(): void {
    overview = null;
    browseTask.reset();
    categoriesStarted = false;
    categoriesTask.reset();
    cancelSearch();
    loadMoreTask.reset();
  }

  function cancelSearch() {
    clearTimeout(searchTimer ?? undefined);
    searchTimer = null;
  }

  async function refresh(): Promise<void> {
    // Inventory publication and explicit refresh retire cached local installation facts.
    overview = null;
    await loadSelection();
  }

  async function loadSelection(manual = false): Promise<void> {
    const client = gateway.getClient();
    if (!client || !gateway.isConnected()) {
      return;
    }
    state.error = null;
    state.remoteError = null;
    state.loadMoreError = null;
    loadMoreTask.reset();
    if (isGroupedOverview() && overview) {
      // Retire the search before restoring the overview; late results belong to the old intent.
      browseTask.reset();
      applyPage(overview);
      onChange();
      return;
    }
    await browseTask.run([client, state.intent, state.category, committedQuery, manual]);
  }

  async function loadMore(): Promise<void> {
    const client = gateway.getClient();
    const cursor = state.result?.nextCursor;
    if (!client || !gateway.isConnected() || !cursor || committedQuery || isGroupedOverview()) {
      return;
    }
    state.loadMoreError = null;
    await loadMoreTask.run([client, state.intent, state.category, committedQuery, cursor]);
  }

  function selectIntent(intent: PluginDiscoveryIntent): Promise<void> {
    state.intent = intent;
    state.category = null;
    return loadSelection();
  }

  function selectCategory(category: string | null): Promise<void> {
    state.intent = "all";
    state.category = category;
    return loadSelection();
  }

  function updateQuery(query: string): void {
    const previousQuery = state.query.trim();
    const nextQuery = query.trim();
    const resetFilters = Boolean(nextQuery) && (state.intent !== "all" || state.category !== null);
    state.query = query;
    if (nextQuery) {
      state.intent = "all";
      state.category = null;
    }
    onChange();
    cancelSearch();
    // Canceling a debounce can leave reset filters whose results still need loading.
    if (
      nextQuery === committedQuery &&
      !resetFilters &&
      (nextQuery === previousQuery ||
        (resultSelection?.intent === state.intent && resultSelection.category === state.category))
    ) {
      return;
    }
    if (!nextQuery) {
      committedQuery = "";
      void loadSelection();
      return;
    }
    searchTimer = setTimeout(() => {
      searchTimer = null;
      // Only a newly settled query records a manual search.
      const manual = nextQuery !== committedQuery && nextQuery.length >= 2;
      committedQuery = nextQuery;
      void loadSelection(manual);
    }, 250);
  }

  onCleanup(cancelSearch);
  return {
    read: (): Readonly<typeof state> => state,
    invalidate,
    disconnect,
    refresh,
    loadMore,
    ensureCategories,
    selectIntent,
    selectCategory,
    updateQuery,
  };
}
