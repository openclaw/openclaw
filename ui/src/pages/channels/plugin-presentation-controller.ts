import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { fetchPluginIconBlobUrl } from "../plugins/icon-loader.ts";
import { pluginIconFetchContext } from "../plugins/plugin-icon-controller.ts";
import { resolveChannelIconOwner } from "./plugin-presentation.ts";

const CHANNEL_PLUGIN_ICON_TIMEOUT_MS = 10_000;

type PluginPresentationRequest = {
  client: GatewayBrowserClient;
  controller: AbortController;
  iconTimeout?: ReturnType<typeof setTimeout>;
  theme: "light" | "dark";
};

type PluginPresentationHooks = {
  getContext: () => ApplicationContext;
  getChannelIds: () => readonly string[];
  isConnected: () => boolean;
  requestUpdate: () => void;
};

export class ChannelPluginPresentationController {
  private catalog: PluginListResult | null = null;
  private readonly iconUrls = new Map<string, string>();
  private request: PluginPresentationRequest | null = null;
  private theme?: "light" | "dark";
  private pendingEnsureClient: GatewayBrowserClient | null = null;

  constructor(private readonly hooks: PluginPresentationHooks) {}

  get pluginCatalog() {
    return this.catalog;
  }

  get pluginIconUrls() {
    if (!this.catalog) {
      return {};
    }
    const plugins = this.catalog.plugins;
    return Object.fromEntries(
      this.hooks.getChannelIds().flatMap((channelId) => {
        const plugin = resolveChannelIconOwner(plugins, channelId);
        const url = plugin ? this.iconUrls.get(plugin.id) : undefined;
        return url === undefined ? [] : [[channelId, url] as const];
      }),
    );
  }

  ensure(client: GatewayBrowserClient | null) {
    if (!client) {
      return;
    }
    const theme = this.hooks.getContext().theme.resolvedMode;
    if (theme !== this.theme) {
      this.theme = theme;
      this.resetIcons();
    }
    if (this.request?.client === client) {
      if (this.catalog) {
        this.pendingEnsureClient = client;
      }
      return;
    }
    if (this.catalog) {
      this.startIconLoad(client, this.catalog);
      return;
    }
    this.request?.controller.abort();
    const controller = new AbortController();
    const request: PluginPresentationRequest = { client, controller, theme };
    this.request = request;
    void client
      .request<PluginListResult>("plugins.list", {}, { signal: controller.signal })
      .then(async (result) => {
        if (
          this.request !== request ||
          this.hooks.getContext().gateway.snapshot.client !== client
        ) {
          return;
        }
        this.catalog = result;
        this.hooks.requestUpdate();
        await this.loadIcons(result, request);
      })
      .catch(() => {
        // Channel status metadata remains a complete fallback when catalog loading fails.
      })
      .finally(() => this.finishRequest(request));
  }

  private startIconLoad(client: GatewayBrowserClient, catalog: PluginListResult) {
    this.request?.controller.abort();
    const request: PluginPresentationRequest = {
      client,
      controller: new AbortController(),
      theme: this.hooks.getContext().theme.resolvedMode,
    };
    this.request = request;
    void this.loadIcons(catalog, request).finally(() => this.finishRequest(request));
  }

  private async loadIcons(result: PluginListResult, request: PluginPresentationRequest) {
    request.iconTimeout = setTimeout(
      () =>
        request.controller.abort(new DOMException("plugin icon fetch timed out", "TimeoutError")),
      CHANNEL_PLUGIN_ICON_TIMEOUT_MS,
    );
    // The plugin owns the URL, including channels that arrive in a later status snapshot.
    const iconTargets = new Set<string>();
    for (const channelId of this.hooks.getChannelIds()) {
      const plugin = resolveChannelIconOwner(result.plugins, channelId);
      if (plugin && !this.iconUrls.has(plugin.id)) {
        iconTargets.add(plugin.id);
      }
    }
    const iconEntries = await Promise.all(
      [...iconTargets].map(async (pluginId) => {
        const url = await fetchPluginIconBlobUrl({
          pluginId,
          theme: request.theme,
          ...pluginIconFetchContext(this.hooks.getContext()),
          signal: request.controller.signal,
        }).catch(() => null);
        return [pluginId, url] as const;
      }),
    );
    const loadedUrls = iconEntries.filter(
      (entry): entry is readonly [string, string] => entry[1] !== null,
    );
    if (
      this.request !== request ||
      request.theme !== this.hooks.getContext().theme.resolvedMode ||
      !this.hooks.isConnected()
    ) {
      for (const [, url] of loadedUrls) {
        URL.revokeObjectURL(url);
      }
      return;
    }
    for (const [pluginId, url] of loadedUrls) {
      this.iconUrls.set(pluginId, url);
    }
    this.hooks.requestUpdate();
  }

  private finishRequest(request: PluginPresentationRequest) {
    if (request.iconTimeout) {
      clearTimeout(request.iconTimeout);
    }
    if (this.request !== request) {
      return;
    }
    this.request = null;
    const pendingClient = this.pendingEnsureClient;
    this.pendingEnsureClient = null;
    if (pendingClient && this.hooks.isConnected()) {
      this.ensure(pendingClient);
    }
  }

  private resetIcons() {
    this.request?.controller.abort();
    if (this.request?.iconTimeout) {
      clearTimeout(this.request.iconTimeout);
    }
    this.request = null;
    this.pendingEnsureClient = null;
    for (const url of this.iconUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.iconUrls.clear();
    this.hooks.requestUpdate();
  }

  reset() {
    this.catalog = null;
    this.resetIcons();
  }
}
