import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { PluginIconController, pluginIconFetchContext } from "../plugins/plugin-icon-controller.ts";
import { resolveChannelIconOwner } from "./plugin-presentation.ts";

type PluginPresentationRequest = {
  client: GatewayBrowserClient;
  controller: AbortController;
};

type PluginPresentationHooks = {
  getContext: () => ApplicationContext;
  getChannelIds: () => readonly string[];
  isConnected: () => boolean;
  requestUpdate: () => void;
};

export class ChannelPluginPresentationController {
  private catalog: PluginListResult | null = null;
  private iconUrls: Record<string, string> = {};
  private request: PluginPresentationRequest | null = null;
  private readonly icons: PluginIconController;

  constructor(private readonly hooks: PluginPresentationHooks) {
    this.icons = new PluginIconController({
      getFetchContext: () => pluginIconFetchContext(hooks.getContext()),
      isConnected: () => hooks.isConnected(),
      onUrlsChange: (urls) => {
        this.iconUrls = urls;
        hooks.requestUpdate();
      },
    });
  }

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
        const url = plugin ? this.iconUrls[plugin.id] : undefined;
        return url === undefined ? [] : [[channelId, url] as const];
      }),
    );
  }

  ensure(client: GatewayBrowserClient | null) {
    if (!client) {
      return;
    }
    if (this.catalog) {
      for (const channelId of this.hooks.getChannelIds()) {
        const plugin = resolveChannelIconOwner(this.catalog.plugins, channelId);
        if (plugin && !this.iconUrls[plugin.id] && !this.icons.isLoading(plugin.id)) {
          // A later channel refresh retries missing artwork.
          this.icons.invalidate(plugin.id);
          this.icons.load(plugin.id);
        }
      }
      return;
    }
    if (this.request?.client === client) {
      return;
    }
    this.request?.controller.abort();
    const controller = new AbortController();
    const request: PluginPresentationRequest = { client, controller };
    this.request = request;
    void client
      .request<PluginListResult>("plugins.list", {}, { signal: controller.signal })
      .then((result) => {
        if (
          this.request !== request ||
          this.hooks.getContext().gateway.snapshot.client !== client
        ) {
          return;
        }
        this.catalog = result;
        this.hooks.requestUpdate();
        this.ensure(client);
      })
      .catch(() => {
        // Channel status metadata remains a complete fallback when catalog loading fails.
      })
      .finally(() => {
        if (this.request === request) {
          this.request = null;
        }
      });
  }

  reset() {
    this.request?.controller.abort();
    this.request = null;
    this.catalog = null;
    this.icons.reset();
  }
}
