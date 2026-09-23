import type { PluginDiscoveryEntry, PluginListResult } from "../../lib/plugins/index.ts";
import {
  fetchCatalogIconBlobUrl,
  fetchPluginIconBlobUrl,
  type PluginIconFetchContext,
} from "./icon-loader.ts";

type PluginIconControllerHost = {
  readonly kind?: "plugin" | "catalog";
  getFetchContext: () => PluginIconFetchContext;
  isConnected: (key: string) => boolean;
  fetchIcon?: (
    key: string,
    context: PluginIconFetchContext,
    signal: AbortSignal,
  ) => Promise<string | null>;
  timeoutError?: () => DOMException;
  onUrlsChange: (urls: Record<string, string>) => void;
  onLoadingChange?: () => void;
};

export class PluginIconController {
  private readonly misses = new Set<string>();
  private readonly requests = new Map<
    string,
    { controller: AbortController; timeout: ReturnType<typeof setTimeout> | undefined }
  >();
  private urls: Record<string, string> = {};

  constructor(private readonly host: PluginIconControllerHost) {}

  syncCatalog(entries: readonly PluginDiscoveryEntry[], extraUrls: readonly string[] = []): void {
    const eligible = new Set([
      ...entries.flatMap((entry) => (entry.catalog.imageUrl ? [entry.catalog.imageUrl] : [])),
      ...extraUrls,
    ]);
    this.reconcileKeys(eligible);
    for (const key of eligible) {
      this.load(key);
    }
  }

  isLoading(key: string): boolean {
    return this.requests.has(key);
  }

  reconcile(result: PluginListResult | null) {
    const eligiblePluginIds = new Set(
      (result?.plugins ?? []).filter((plugin) => plugin.hasIcon).map((plugin) => plugin.id),
    );
    this.reconcileKeys(eligiblePluginIds);
  }

  reconcileKeys(eligiblePluginIds: ReadonlySet<string>) {
    const nextUrls = { ...this.urls };
    let urlsChanged = false;
    for (const [pluginId, url] of Object.entries(nextUrls)) {
      if (!eligiblePluginIds.has(pluginId)) {
        URL.revokeObjectURL(url);
        delete nextUrls[pluginId];
        urlsChanged = true;
      }
    }
    if (urlsChanged && this.host.kind !== "catalog") {
      this.publish(nextUrls);
    }
    for (const [pluginId, request] of this.requests) {
      if (!eligiblePluginIds.has(pluginId)) {
        clearTimeout(request.timeout);
        request.controller.abort();
        this.requests.delete(pluginId);
        this.host.onLoadingChange?.();
      }
    }
    // Catalog keeps failures until reset and publishes pruning after cancellation notifications.
    if (this.host.kind === "catalog") {
      if (urlsChanged) {
        this.publish(nextUrls);
      }
      return;
    }
    for (const pluginId of this.misses) {
      if (!eligiblePluginIds.has(pluginId)) {
        this.misses.delete(pluginId);
      }
    }
  }

  reset() {
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.controller.abort();
    }
    for (const url of Object.values(this.urls)) {
      URL.revokeObjectURL(url);
    }
    this.requests.clear();
    this.host.onLoadingChange?.();
    this.misses.clear();
    if (this.host.kind !== "catalog" || Object.keys(this.urls).length > 0) {
      this.publish({});
    }
  }

  sync(result: PluginListResult | null, renderedPluginIds: ReadonlySet<string>) {
    for (const plugin of result?.plugins ?? []) {
      if (plugin.hasIcon && renderedPluginIds.has(plugin.id)) {
        this.load(plugin.id);
      }
    }
  }

  load(pluginId: string): void {
    if (!this.urls[pluginId] && !this.misses.has(pluginId) && !this.requests.has(pluginId)) {
      this.fetch(pluginId);
    }
  }

  handleError(pluginId: string) {
    this.invalidate(pluginId);
    this.misses.add(pluginId);
  }

  invalidate(pluginId: string) {
    const request = this.requests.get(pluginId);
    if (request) {
      clearTimeout(request.timeout);
      request.controller.abort();
      this.requests.delete(pluginId);
      this.host.onLoadingChange?.();
    }
    const url = this.urls[pluginId];
    if (url) {
      URL.revokeObjectURL(url);
    }
    const nextUrls = { ...this.urls };
    delete nextUrls[pluginId];
    this.publish(nextUrls);
    this.misses.delete(pluginId);
  }

  private publish(urls: Record<string, string>) {
    this.urls = urls;
    this.host.onUrlsChange(urls);
  }

  private fetch(pluginId: string) {
    const controller = new AbortController();
    const timeout =
      this.host.kind === "catalog"
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                this.host.timeoutError?.() ??
                  new DOMException("plugin icon fetch timed out", "TimeoutError"),
              ),
            10_000,
          );
    const request = { controller, timeout };
    this.requests.set(pluginId, request);
    this.host.onLoadingChange?.();
    const context = this.host.getFetchContext();
    const pending = this.host.fetchIcon
      ? this.host.fetchIcon(pluginId, context, controller.signal)
      : this.host.kind === "catalog"
        ? fetchCatalogIconBlobUrl({ iconUrl: pluginId, ...context, signal: controller.signal })
        : fetchPluginIconBlobUrl({ pluginId, ...context, signal: controller.signal });
    void pending
      .then((url) => {
        if (this.requests.get(pluginId) !== request || !this.host.isConnected(pluginId)) {
          if (url) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        if (url) {
          this.publish({ ...this.urls, [pluginId]: url });
        } else {
          this.misses.add(pluginId);
        }
      })
      .catch(() => {
        if (
          this.requests.get(pluginId) === request &&
          (this.host.kind !== "catalog" || !controller.signal.aborted)
        ) {
          this.misses.add(pluginId);
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.requests.get(pluginId) === request) {
          this.requests.delete(pluginId);
          this.host.onLoadingChange?.();
        }
      });
  }
}
