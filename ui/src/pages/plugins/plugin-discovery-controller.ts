import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import type {
  PluginDiscoveryCategoriesResult,
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import type { PluginDiscoveryIntent } from "./catalog-results.ts";

const CATALOG_PAGE_SIZE = 100;
const CATALOG_SECTION_SIZE = 8;

type CatalogPageLoad = {
  items: PluginDiscoveryEntry[];
  remoteError?: string;
};

type PluginDiscoveryGateway = {
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
  capture: () => GatewayConnectionScope | null;
  isCurrent: (scope: GatewayConnectionScope) => boolean;
  onEntriesChanged?: () => void;
};

function compareOfficialDownloads(left: PluginDiscoveryEntry, right: PluginDiscoveryEntry): number {
  if (left.catalog.official !== right.catalog.official) {
    return left.catalog.official ? -1 : 1;
  }
  const downloadOrder = (right.catalog.downloads ?? 0) - (left.catalog.downloads ?? 0);
  return downloadOrder || left.catalog.name.localeCompare(right.catalog.name);
}

function localFactStrength(entry: PluginDiscoveryEntry): number {
  return (
    Number(entry.local.installed) * 4 +
    Number(entry.local.present) * 2 +
    Number(Boolean(entry.local.pluginId))
  );
}

function hasPublishedCatalogFacts(entry: PluginDiscoveryEntry): boolean {
  return entry.catalog.family !== undefined;
}

function mergeDiscoveryEntry(
  existing: PluginDiscoveryEntry,
  incoming: PluginDiscoveryEntry,
  category?: string,
): PluginDiscoveryEntry {
  const categories = new Set([
    ...existing.catalog.categories,
    ...incoming.catalog.categories,
    ...(category ? [category] : []),
  ]);
  // The Gateway's local placeholder deliberately omits family, while every ClawHub result owns it.
  // Keep published presentation regardless of cursor/category arrival order; local runtime facts merge below.
  const preferIncomingCatalog =
    hasPublishedCatalogFacts(incoming) && !hasPublishedCatalogFacts(existing);
  const preferredCatalog = preferIncomingCatalog ? incoming.catalog : existing.catalog;
  const fallbackCatalog = preferIncomingCatalog ? existing.catalog : incoming.catalog;
  return {
    id: existing.id,
    catalog: {
      ...fallbackCatalog,
      ...preferredCatalog,
      official: existing.catalog.official || incoming.catalog.official,
      categories: [...categories],
    },
    local:
      localFactStrength(existing) > localFactStrength(incoming) ? existing.local : incoming.local,
  };
}

function mergeDiscoveryEntryInto(
  entries: Map<string, PluginDiscoveryEntry>,
  incoming: PluginDiscoveryEntry,
  category?: string,
): void {
  const existing = entries.get(incoming.id);
  entries.set(
    incoming.id,
    existing
      ? mergeDiscoveryEntry(existing, incoming, category)
      : category
        ? mergeDiscoveryEntry(incoming, incoming, category)
        : incoming,
  );
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
  private overviewRequestEpoch = 0;
  private readonly browseTask: Task;
  private readonly categoriesTask: Task;
  private readonly featuredTask: Task;
  private readonly trendingTask: Task;

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
        this.gateway.onEntriesChanged?.();
      },
      onError: (error) => {
        this.error = formatUiError(error);
      },
    });
    this.categoriesTask = new Task(host, {
      autoRun: false,
      args: () => [this.gateway.isConnected() ? this.gateway.getClient() : null] as const,
      task: ([client], { signal }) =>
        client
          ? client.request<PluginDiscoveryCategoriesResult>(
              "plugins.catalog.categories",
              {},
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.categories = result.categories;
      },
      onError: (error) => {
        this.categoriesError = formatUiError(error);
      },
    });
    this.featuredTask = new Task(host, {
      autoRun: false,
      args: () => [this.gateway.isConnected() ? this.gateway.getClient() : null] as const,
      task: ([client], { signal }) =>
        client
          ? client.request<PluginDiscoveryResult>(
              "plugins.catalog.browse",
              { intent: "featured", pageSize: CATALOG_SECTION_SIZE },
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.featured = result.items.slice(0, CATALOG_SECTION_SIZE);
        this.featuredError = result.remoteError ?? null;
        this.gateway.onEntriesChanged?.();
      },
      onError: (error) => {
        this.featuredError = formatUiError(error);
      },
    });
    this.trendingTask = new Task(host, {
      autoRun: false,
      args: () => [this.gateway.isConnected() ? this.gateway.getClient() : null] as const,
      task: ([client], { signal }) =>
        client
          ? client.request<PluginDiscoveryResult>(
              "plugins.catalog.browse",
              { intent: "trending", pageSize: CATALOG_SECTION_SIZE },
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.trending = result.items.slice(0, CATALOG_SECTION_SIZE);
        this.trendingError = result.remoteError ?? null;
        this.gateway.onEntriesChanged?.();
      },
      onError: (error) => {
        this.trendingError = formatUiError(error);
      },
    });
  }

  get loading(): boolean {
    return this.gateway.isConnected() && this.browseTask.status === TaskStatus.PENDING;
  }

  get featuredLoading(): boolean {
    return this.gateway.isConnected() && this.featuredTask.status === TaskStatus.PENDING;
  }

  get trendingLoading(): boolean {
    return this.gateway.isConnected() && this.trendingTask.status === TaskStatus.PENDING;
  }

  private async fetchAvailablePage(params: {
    client: GatewayBrowserClient;
    intent: PluginDiscoveryIntent;
    category: string | null;
    query: string;
    signal?: AbortSignal;
  }): Promise<CatalogPageLoad> {
    const items = new Map<string, PluginDiscoveryEntry>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let remoteError: string | undefined;
    do {
      let page: PluginDiscoveryResult;
      try {
        page = await params.client.request<PluginDiscoveryResult>(
          "plugins.catalog.browse",
          {
            intent: params.intent,
            ...(params.category ? { category: params.category } : {}),
            ...(params.query ? { query: params.query } : {}),
            ...(cursor ? { cursor } : {}),
            pageSize: CATALOG_PAGE_SIZE,
          },
          params.signal ? { signal: params.signal } : undefined,
        );
      } catch (error) {
        if (items.size === 0) {
          throw error;
        }
        remoteError ??= formatUiError(error);
        break;
      }
      for (const item of page.items) {
        mergeDiscoveryEntryInto(items, item);
      }
      remoteError ??= page.remoteError;
      if (page.remoteError) {
        break;
      }
      const nextCursor = params.query ? undefined : page.nextCursor;
      if (nextCursor && cursors.has(nextCursor)) {
        remoteError = "ClawHub returned a repeated plugin catalog cursor.";
        break;
      }
      if (nextCursor) {
        cursors.add(nextCursor);
      }
      cursor = nextCursor;
    } while (cursor);
    const mergedItems =
      params.intent === "all" && !params.query
        ? [...items.values()].toSorted(compareOfficialDownloads)
        : [...items.values()];
    return {
      items: mergedItems,
      ...(remoteError ? { remoteError } : {}),
    };
  }

  private isGroupedOverview(): boolean {
    return this.intent === "all" && this.category === null && !this.committedQuery;
  }

  private async hydrateOverviewSections(): Promise<void> {
    const scope = this.gateway.capture();
    if (!scope || !this.isGroupedOverview() || !this.result || this.categories.length === 0) {
      return;
    }
    const requestEpoch = ++this.overviewRequestEpoch;
    const sparseCategories = this.categories.filter(
      (category) =>
        (this.result?.items.filter((item) => item.catalog.categories.includes(category.slug))
          .length ?? 0) < CATALOG_SECTION_SIZE,
    );
    const pages = await Promise.allSettled(
      sparseCategories.map((category) =>
        scope.client.request<PluginDiscoveryResult>(
          "plugins.catalog.browse",
          { intent: "all", category: category.slug, pageSize: CATALOG_SECTION_SIZE },
          {},
        ),
      ),
    );
    if (
      requestEpoch !== this.overviewRequestEpoch ||
      !this.gateway.isCurrent(scope) ||
      !this.isGroupedOverview() ||
      !this.result
    ) {
      return;
    }
    const items = new Map(this.result.items.map((item) => [item.id, item]));
    for (const [index, loaded] of pages.entries()) {
      if (loaded.status !== "fulfilled") {
        this.remoteError ??= formatUiError(loaded.reason);
        continue;
      }
      const page = loaded.value;
      const category = sparseCategories[index];
      for (const item of page.items) {
        mergeDiscoveryEntryInto(items, item, category?.slug);
      }
      this.remoteError ??= page.remoteError ?? null;
    }
    const mergedItems = [...items.values()].toSorted(compareOfficialDownloads);
    this.result = { items: mergedItems };
    this.gateway.onEntriesChanged?.();
    this.host.requestUpdate();
  }

  ensureInitial(): void {
    if (!this.gateway.isConnected() || !this.gateway.getClient()) {
      return;
    }
    if (this.browseTask.status === TaskStatus.INITIAL && !this.result && !this.error) {
      void this.refresh();
    }
    if (
      this.categoriesTask.status === TaskStatus.INITIAL &&
      this.categories.length === 0 &&
      !this.categoriesError
    ) {
      void this.refreshCategories();
    }
    if (
      this.featuredTask.status === TaskStatus.INITIAL &&
      this.featured.length === 0 &&
      !this.featuredError
    ) {
      void this.refreshFeatured();
    }
    if (
      this.trendingTask.status === TaskStatus.INITIAL &&
      this.trending.length === 0 &&
      !this.trendingError
    ) {
      void this.refreshTrending();
    }
  }

  invalidate(): void {
    void this.browseTask.run([null, this.intent, this.category, this.committedQuery]);
    void this.categoriesTask.run([null]);
    void this.featuredTask.run([null]);
    void this.trendingTask.run([null]);
    this.result = null;
    this.error = null;
    this.remoteError = null;
    this.categories = [];
    this.categoriesError = null;
    this.featured = [];
    this.featuredError = null;
    this.trending = [];
    this.trendingError = null;
    this.overviewRequestEpoch += 1;
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
    this.overviewRequestEpoch += 1;
    await this.browseTask.run([client, this.intent, this.category, this.committedQuery]);
    await this.hydrateOverviewSections();
  }

  async refreshCategories(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.categoriesError = null;
    await this.categoriesTask.run([client]);
    await this.hydrateOverviewSections();
  }

  async refreshFeatured(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.featuredError = null;
    await this.featuredTask.run([client]);
  }

  async refreshTrending(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.trendingError = null;
    await this.trendingTask.run([client]);
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
