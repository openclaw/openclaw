import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type {
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import type { PluginDiscoveryIntent } from "./catalog-results.ts";

const CATALOG_PAGE_SIZE = 100;
const CATALOG_SECTION_SIZE = 8;
const NO_CATALOG_CLIENT: GatewayBrowserClient | null = null;
const NO_CATALOG_CURSOR: string | null = null;

type CatalogPageLoad = {
  items: PluginDiscoveryEntry[];
  overview: boolean;
  selection: {
    intent: PluginDiscoveryIntent;
    category: string | null;
    query: string;
  };
  categories?: PluginDiscoveryCategory[];
  nextCursor?: string;
  remoteError?: string;
};

type PluginDiscoveryGateway = {
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
};

function compareOfficialDownloads(left: PluginDiscoveryEntry, right: PluginDiscoveryEntry): number {
  if (left.catalog.official !== right.catalog.official) {
    return left.catalog.official ? -1 : 1;
  }
  const downloadOrder = (right.catalog.downloads ?? 0) - (left.catalog.downloads ?? 0);
  return downloadOrder || left.catalog.name.localeCompare(right.catalog.name);
}

function rankedOverviewShelf(
  items: readonly PluginDiscoveryEntry[],
  membership: "featured" | "trending",
  rank: "featuredRank" | "trendingRank",
): PluginDiscoveryEntry[] {
  return items
    .filter((item) => item.catalog[membership])
    .toSorted(
      (left, right) =>
        (left.catalog[rank] ?? Number.MAX_SAFE_INTEGER) -
        (right.catalog[rank] ?? Number.MAX_SAFE_INTEGER),
    );
}

function appendUniqueEntries(
  existing: readonly PluginDiscoveryEntry[],
  incoming: readonly PluginDiscoveryEntry[],
): PluginDiscoveryEntry[] {
  const entries = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    // Cursor pages contain remote catalog projections, so they replace any first-page local
    // placeholder while carrying forward the Gateway's latest authoritative local state.
    entries.set(item.id, item);
  }
  return [...entries.values()];
}

export class PluginDiscoveryController {
  result: PluginDiscoveryResult | null = null;
  private resultSelection: CatalogPageLoad["selection"] | null = null;
  error: string | null = null;
  remoteError: string | null = null;
  categories: PluginDiscoveryCategory[] = [];
  categoriesError: string | null = null;
  private categoriesReady = false;
  private categoriesStarted = false;
  private readonly categoriesTask: Task;
  featured: PluginDiscoveryEntry[] = [];
  trending: PluginDiscoveryEntry[] = [];
  loadMoreError: string | null = null;
  intent: PluginDiscoveryIntent = "all";
  category: string | null = null;
  query = "";

  private committedQuery = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly browseTask: Task;
  private readonly loadMoreTask: Task;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly gateway: PluginDiscoveryGateway,
  ) {
    this.categoriesTask = new Task(host, {
      autoRun: false,
      args: () => [NO_CATALOG_CLIENT] as const,
      task: ([client], { signal }) =>
        client
          ? client.request<{ categories: PluginDiscoveryCategory[] }>(
              "plugins.catalog.categories",
              {},
              { signal },
            )
          : initialState,
      onComplete: ({ categories }) => {
        this.categories = categories;
        this.categoriesReady = true;
        this.categoriesError = null;
      },
      onError: (error) => {
        this.categoriesError = formatUiError(error);
      },
    });
    this.browseTask = new Task(host, {
      autoRun: false,
      args: () =>
        [
          this.gateway.isConnected() ? this.gateway.getClient() : null,
          this.intent,
          this.category,
          this.committedQuery,
          false,
        ] as const,
      task: ([client, intent, category, query, manual], { signal }) =>
        client
          ? this.fetchAvailablePage({ client, intent, category, query, manual, signal })
          : initialState, // Lit returns to INITIAL without invoking onComplete.
      onComplete: (page) => {
        this.result = {
          items: page.items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
        this.resultSelection = page.selection;
        this.remoteError = page.remoteError ?? null;
        if (page.overview) {
          // The overview is already fetched for cards. Use its canonical categories
          // if it beats the lightweight read (including older ClawHub servers that
          // cannot serve that endpoint), and retire the slower request.
          if (page.categories) {
            void this.categoriesTask.run([null]);
            this.categories = page.categories;
            this.categoriesReady = true;
            this.categoriesError = null;
          }
          this.featured = rankedOverviewShelf(page.items, "featured", "featuredRank").slice(
            0,
            CATALOG_SECTION_SIZE,
          );
          this.trending = rankedOverviewShelf(page.items, "trending", "trendingRank").slice(
            0,
            CATALOG_SECTION_SIZE,
          );
        }
      },
      onError: (error) => {
        this.error = formatUiError(error);
      },
    });
    this.loadMoreTask = new Task(host, {
      autoRun: false,
      args: () =>
        [
          NO_CATALOG_CLIENT,
          this.intent,
          this.category,
          this.committedQuery,
          NO_CATALOG_CURSOR,
        ] as const,
      task: ([client, intent, category, query, cursor], { signal }) =>
        client && cursor
          ? this.fetchAvailablePage({ client, intent, category, query, cursor, signal })
          : initialState,
      onComplete: (page) => {
        if (!this.result || this.result.nextCursor !== page.requestedCursor) {
          return;
        }
        const items = appendUniqueEntries(this.result.items, page.items);
        this.result = {
          items:
            this.intent === "all" && !this.committedQuery
              ? items.toSorted(compareOfficialDownloads)
              : items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
        this.loadMoreError = page.remoteError ?? null;
      },
      onError: (error) => {
        this.loadMoreError = formatUiError(error);
      },
    });
  }

  get loading(): boolean {
    // Keep keyed cards and their open controls during a same-selection refresh.
    // New filters must wait for their own result instead of showing the old selection.
    return (
      this.gateway.isConnected() &&
      this.browseTask.status === TaskStatus.PENDING &&
      (!this.result ||
        this.resultSelection?.intent !== this.intent ||
        this.resultSelection.category !== this.category ||
        this.resultSelection.query !== this.committedQuery)
    );
  }

  get categoriesLoading(): boolean {
    return (
      this.gateway.isConnected() &&
      this.categoriesStarted &&
      !this.categoriesReady &&
      this.categoriesTask.status === TaskStatus.PENDING
    );
  }

  async ensureCategories(retry = false): Promise<void> {
    const client = this.gateway.getClient();
    if (
      !client ||
      !this.gateway.isConnected() ||
      this.categoriesReady ||
      (this.categoriesStarted && (this.categoriesTask.status === TaskStatus.PENDING || !retry))
    ) {
      return;
    }
    this.categoriesError = null;
    this.categoriesStarted = true;
    await this.categoriesTask.run([client]);
  }

  get featuredLoading(): boolean {
    return this.isGroupedOverview() && this.loading;
  }

  get trendingLoading(): boolean {
    return this.isGroupedOverview() && this.loading;
  }

  get loadingMore(): boolean {
    return this.gateway.isConnected() && this.loadMoreTask.status === TaskStatus.PENDING;
  }

  private async fetchAvailablePage(params: {
    client: GatewayBrowserClient;
    intent: PluginDiscoveryIntent;
    category: string | null;
    query: string;
    manual?: boolean;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<CatalogPageLoad & { requestedCursor?: string }> {
    const overview =
      !params.cursor && this.isGroupedOverview(params.intent, params.category, params.query);
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
      params.signal ? { signal: params.signal } : undefined,
    );
    const items =
      params.intent === "all" && !params.query
        ? page.items.toSorted(compareOfficialDownloads)
        : page.items;
    return {
      items,
      overview,
      selection: { intent: params.intent, category: params.category, query: params.query },
      ...(page.categories ? { categories: page.categories } : {}),
      ...(page.nextCursor && !params.query ? { nextCursor: page.nextCursor } : {}),
      ...(page.remoteError ? { remoteError: page.remoteError } : {}),
      ...(params.cursor ? { requestedCursor: params.cursor } : {}),
    };
  }

  private isGroupedOverview(
    intent = this.intent,
    category = this.category,
    query = this.committedQuery,
  ): boolean {
    return intent === "all" && category === null && !query;
  }

  invalidate(): void {
    // Reconnects reload the latest input without replaying its manual observation.
    this.disconnect();
    this.committedQuery = this.query.trim();
    void this.browseTask.run([null, this.intent, this.category, this.committedQuery, false]);
    this.result = null;
    this.resultSelection = null;
    this.categories = [];
    this.categoriesReady = false;
    this.categoriesError = null;
    this.error = null;
    this.remoteError = null;
    this.featured = [];
    this.trending = [];
    this.loadMoreError = null;
  }

  disconnect(): void {
    this.categoriesStarted = false;
    void this.categoriesTask.run([null]);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    void this.loadMoreTask.run([null, this.intent, this.category, this.committedQuery, null]);
  }

  async refresh(manual = false): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.error = null;
    this.remoteError = null;
    this.loadMoreError = null;
    void this.loadMoreTask.run([null, this.intent, this.category, this.committedQuery, null]);
    await this.browseTask.run([client, this.intent, this.category, this.committedQuery, manual]);
  }

  async loadMore(): Promise<void> {
    const client = this.gateway.getClient();
    const cursor = this.result?.nextCursor;
    if (
      !client ||
      !this.gateway.isConnected() ||
      !cursor ||
      this.committedQuery ||
      this.isGroupedOverview()
    ) {
      return;
    }
    this.loadMoreError = null;
    await this.loadMoreTask.run([client, this.intent, this.category, this.committedQuery, cursor]);
  }

  selectIntent(intent: PluginDiscoveryIntent): void {
    this.intent = intent;
    this.category = null;
    void this.refresh();
  }

  selectCategory(category: string | null): void {
    this.intent = "all";
    this.category = category;
    void this.refresh();
  }

  updateQuery(query: string): void {
    this.query = query;
    if (query.trim()) {
      this.intent = "all";
      this.category = null;
    }
    this.host.requestUpdate();
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      const nextQuery = query.trim();
      // Whitespace edits and repeated input refresh results without recording another search.
      const manual = nextQuery !== this.committedQuery && nextQuery.length >= 2;
      this.committedQuery = nextQuery;
      void this.refresh(manual);
    }, 250);
  }
}
