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
  categories?: PluginDiscoveryCategory[];
  nextCursor?: string;
  remoteError?: string;
};

type PluginDiscoveryGateway = {
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
  onEntriesChanged?: () => void;
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
  error: string | null = null;
  remoteError: string | null = null;
  categories: PluginDiscoveryCategory[] = [];
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
    this.browseTask = new Task(host, {
      // Scope changes call refresh(), which invalidates overview hydration before this task runs.
      autoRun: false,
      args: () =>
        [
          this.gateway.isConnected() ? this.gateway.getClient() : null,
          this.intent,
          this.category,
          this.committedQuery,
        ] as const,
      task: ([client, intent, category, query], { signal }) =>
        client
          ? this.fetchAvailablePage({ client, intent, category, query, signal })
          : initialState, // Lit returns to INITIAL without invoking onComplete.
      onComplete: (page) => {
        this.result = {
          items: page.items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
        this.remoteError = page.remoteError ?? null;
        if (this.isGroupedOverview()) {
          this.categories = page.categories ?? [];
          this.featured = rankedOverviewShelf(page.items, "featured", "featuredRank").slice(
            0,
            CATALOG_SECTION_SIZE,
          );
          this.trending = rankedOverviewShelf(page.items, "trending", "trendingRank").slice(
            0,
            CATALOG_SECTION_SIZE,
          );
        }
        this.gateway.onEntriesChanged?.();
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
        this.gateway.onEntriesChanged?.();
      },
      onError: (error) => {
        this.loadMoreError = formatUiError(error);
      },
    });
  }

  get loading(): boolean {
    return this.gateway.isConnected() && this.browseTask.status === TaskStatus.PENDING;
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
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<CatalogPageLoad & { requestedCursor?: string }> {
    const page = await params.client.request<PluginDiscoveryResult>(
      "plugins.catalog.browse",
      {
        intent: params.intent,
        ...(params.category ? { category: params.category } : {}),
        ...(params.query ? { query: params.query } : {}),
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
      ...(page.categories ? { categories: page.categories } : {}),
      ...(page.nextCursor && !params.query ? { nextCursor: page.nextCursor } : {}),
      ...(page.remoteError ? { remoteError: page.remoteError } : {}),
      ...(params.cursor ? { requestedCursor: params.cursor } : {}),
    };
  }

  private isGroupedOverview(): boolean {
    return this.intent === "all" && this.category === null && !this.committedQuery;
  }

  ensureInitial(): void {
    if (!this.gateway.isConnected() || !this.gateway.getClient()) {
      return;
    }
    if (this.browseTask.status === TaskStatus.INITIAL && !this.result && !this.error) {
      void this.refresh();
    }
  }

  invalidate(): void {
    void this.browseTask.run([null, this.intent, this.category, this.committedQuery]);
    this.result = null;
    this.error = null;
    this.remoteError = null;
    this.featured = [];
    this.trending = [];
    this.loadMoreError = null;
    void this.loadMoreTask.run([null, this.intent, this.category, this.committedQuery, null]);
  }

  disconnect(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    void this.loadMoreTask.run([null, this.intent, this.category, this.committedQuery, null]);
  }

  async refresh(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.error = null;
    this.remoteError = null;
    this.loadMoreError = null;
    void this.loadMoreTask.run([null, this.intent, this.category, this.committedQuery, null]);
    await this.browseTask.run([client, this.intent, this.category, this.committedQuery]);
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
      this.committedQuery = query.trim();
      void this.refresh();
    }, 250);
  }
}
