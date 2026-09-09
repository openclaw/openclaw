import type { PluginListResult } from "../../lib/plugins/index.ts";
import { fetchPluginIconBlobUrl, type PluginIconFetchContext } from "./icon-loader.ts";

type PluginIconControllerHost = {
  getFetchContext: () => PluginIconFetchContext;
  isConnected: () => boolean;
  onUrlsChange: (urls: Record<string, string>) => void;
  onLoadingChange?: () => void;
};

export class PluginIconController {
  private readonly misses = new Set<string>();
  private readonly requests = new Map<
    string,
    { controller: AbortController; timeout: ReturnType<typeof setTimeout> }
  >();
  private urls: Record<string, string> = {};

  constructor(private readonly host: PluginIconControllerHost) {}

  isLoading(key: string): boolean {
    return this.requests.has(key);
  }

  reconcile(result: PluginListResult | null) {
    const eligiblePluginIds = new Set(
      (result?.plugins ?? []).filter((plugin) => plugin.hasIcon).map((plugin) => plugin.id),
    );
    const nextUrls = { ...this.urls };
    let urlsChanged = false;
    for (const [pluginId, url] of Object.entries(nextUrls)) {
      if (!eligiblePluginIds.has(pluginId)) {
        URL.revokeObjectURL(url);
        delete nextUrls[pluginId];
        urlsChanged = true;
      }
    }
    if (urlsChanged) {
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
    this.publish({});
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
    const timeout = setTimeout(
      () => controller.abort(new DOMException("plugin icon fetch timed out", "TimeoutError")),
      10_000,
    );
    const request = { controller, timeout };
    this.requests.set(pluginId, request);
    this.host.onLoadingChange?.();
    void fetchPluginIconBlobUrl({
      pluginId,
      ...this.host.getFetchContext(),
      signal: controller.signal,
    })
      .then((url) => {
        if (this.requests.get(pluginId) !== request || !this.host.isConnected()) {
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
        if (this.requests.get(pluginId) === request) {
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
