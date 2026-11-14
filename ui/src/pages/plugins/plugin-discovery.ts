import { onCleanup } from "solid-js";
import { comparePluginCatalogEntries } from "../../../../packages/plugin-package-contract/src/catalog-order.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createPageRequest, type PageReadResult } from "../../lib/page-request.ts";
import type {
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";

export type PluginDiscoveryIntent = "all" | "bundled" | "trending" | "official" | "featured";
export type PluginDiscoveryState = {
  result: PluginDiscoveryResult | null;
  readonly hasCurrentResult: boolean;
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
  readonly reads: {
    browse: Promise<PageReadResult> | null;
    categories: Promise<PageReadResult> | null;
    more: Promise<PageReadResult> | null;
  };
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
  let search: {
    timer: ReturnType<typeof setTimeout>;
    read: PromiseWithResolvers<PageReadResult>;
  } | null = null;
  const state: PluginDiscoveryState = {
    result: null,
    get hasCurrentResult() {
      return (
        state.result !== null &&
        resultSelection?.intent === state.intent &&
        resultSelection.category === state.category &&
        resultSelection.query === state.query.trim()
      );
    },
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
    get reads() {
      return {
        browse: search?.read.promise ?? browseTask.read,
        categories: categoriesTask.read,
        more: loadMoreTask.read,
      };
    },
  };
  const categoriesTask = createPageRequest(onChange, {
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
  const browseTask = createPageRequest(onChange, {
    task: (
      [client, intent, category, query, manual]: readonly [...CatalogPageArgs, manual: boolean],
      { signal },
    ) => fetchAvailablePage({ client, intent, category, query, manual, signal }),
    onComplete: applyPage,
    onError: (error) => {
      state.error = formatUiError(error);
    },
  });
  const loadMoreTask = createPageRequest(onChange, {
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

  function disconnect(): void {
    overview = null;
    browseTask.reset();
    categoriesStarted = false;
    categoriesTask.reset();
    cancelSearch();
    loadMoreTask.reset();
  }

  function cancelSearch() {
    if (search) {
      clearTimeout(search.timer);
      search.read.resolve(null);
      search = null;
    }
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

  onCleanup(cancelSearch);
  onCleanup(() => {
    categoriesTask.cancel();
    browseTask.cancel();
    loadMoreTask.cancel();
  });
  return {
    read: (): Readonly<typeof state> => state,
    invalidate(): void {
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
    },
    disconnect,
    async refresh(): Promise<void> {
      // Inventory publication and explicit refresh retire cached local installation facts.
      overview = null;
      await loadSelection();
    },
    async loadMore(): Promise<void> {
      const client = gateway.getClient();
      const cursor = state.result?.nextCursor;
      if (!client || !gateway.isConnected() || !cursor || committedQuery || isGroupedOverview()) {
        return;
      }
      state.loadMoreError = null;
      await loadMoreTask.run([client, state.intent, state.category, committedQuery, cursor]);
    },
    async ensureCategories(retry = false): Promise<void> {
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
    },
    selectIntent(intent: PluginDiscoveryIntent): Promise<void> {
      state.intent = intent;
      state.category = null;
      return loadSelection();
    },
    selectCategory(category: string | null): Promise<void> {
      state.intent = "all";
      state.category = category;
      return loadSelection();
    },
    updateQuery(query: string): void {
      const previousQuery = state.query.trim();
      const nextQuery = query.trim();
      const resetFilters =
        Boolean(nextQuery) && (state.intent !== "all" || state.category !== null);
      state.query = query;
      if (nextQuery) {
        state.intent = "all";
        state.category = null;
      }
      cancelSearch();
      // Canceling a debounce can leave reset filters whose results still need loading.
      if (
        nextQuery === committedQuery &&
        !resetFilters &&
        (nextQuery === previousQuery ||
          (resultSelection?.intent === state.intent && resultSelection.category === state.category))
      ) {
        onChange();
        return;
      }
      if (!nextQuery) {
        committedQuery = "";
        void loadSelection();
        onChange();
        return;
      }
      const read = Promise.withResolvers<PageReadResult>();
      const timer = setTimeout(() => {
        search = null;
        // Only a newly settled query records a manual search.
        const manual = nextQuery !== committedQuery && nextQuery.length >= 2;
        committedQuery = nextQuery;
        void loadSelection(manual);
        read.resolve(browseTask.read);
      }, 250);
      search = { timer, read };
      onChange();
    },
  };
}
