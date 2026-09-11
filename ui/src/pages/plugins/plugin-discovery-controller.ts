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

type CatalogPageLoad = {
  items: PluginDiscoveryEntry[];
  categories?: PluginDiscoveryCategory[];
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

export class PluginDiscoveryController {
  result: PluginDiscoveryResult | null = null;
  error: string | null = null;
  remoteError: string | null = null;
  categories: PluginDiscoveryCategory[] = [];
  categoriesError: string | null = null;
  featured: PluginDiscoveryEntry[] = [];
  featuredError: string | null = null;
  trending: PluginDiscoveryEntry[] = [];
  trendingError: string | null = null;
  intent: PluginDiscoveryIntent = "all";
  category: string | null = null;
  query = "";

  private committedQuery = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly browseTask: Task;

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
        this.result = { items: page.items };
        this.remoteError = page.remoteError ?? null;
        if (this.isGroupedOverview()) {
          this.categories = page.categories ?? [];
          this.featured = page.items
            .filter((item) => item.catalog.featured)
            .slice(0, CATALOG_SECTION_SIZE);
          this.trending = page.items
            .filter((item) => item.catalog.trending)
            .slice(0, CATALOG_SECTION_SIZE);
          this.categoriesError = page.remoteError ?? null;
          this.featuredError = page.remoteError ?? null;
          this.trendingError = page.remoteError ?? null;
        }
        this.gateway.onEntriesChanged?.();
      },
      onError: (error) => {
        this.error = formatUiError(error);
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

  private async fetchAvailablePage(params: {
    client: GatewayBrowserClient;
    intent: PluginDiscoveryIntent;
    category: string | null;
    query: string;
    signal?: AbortSignal;
  }): Promise<CatalogPageLoad> {
    const page = await params.client.request<PluginDiscoveryResult>(
      "plugins.catalog.browse",
      {
        intent: params.intent,
        ...(params.category ? { category: params.category } : {}),
        ...(params.query ? { query: params.query } : {}),
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
      ...(page.remoteError ? { remoteError: page.remoteError } : {}),
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
    this.categories = [];
    this.categoriesError = null;
    this.featured = [];
    this.featuredError = null;
    this.trending = [];
    this.trendingError = null;
  }

  disconnect(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  async refresh(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.error = null;
    this.remoteError = null;
    if (this.isGroupedOverview()) {
      this.categoriesError = null;
      this.featuredError = null;
      this.trendingError = null;
    }
    await this.browseTask.run([client, this.intent, this.category, this.committedQuery]);
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
