import { createMemo, onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../plugins/plugin-icon-owner.ts";
import {
  createChannelSettingsPresentation,
  type ChannelSettingsHooks,
} from "./channel-settings-presentation.tsx";

function resolveChannelIconOwner(
  plugins: Readonly<PluginListResult["plugins"]>,
  channelId: string,
) {
  return (
    plugins.find((plugin) => plugin.hasIcon && plugin.id === channelId) ??
    plugins.find((plugin) => plugin.hasIcon && plugin.channelIds?.includes(channelId))
  );
}

type PluginPresentationHooks = ChannelSettingsHooks & {
  getContext: () => ApplicationContext;
  getChannelIds: () => readonly string[];
  isConnected: () => boolean;
};

export function createChannelPluginPresentation(hooks: PluginPresentationHooks) {
  const details = createChannelSettingsPresentation(hooks);
  let catalog: PluginListResult | null = null;
  let iconUrls: Record<string, string> = {};
  let publish = () => {};
  const presentation = projectMutableSource(hooks, () => ({ catalog, iconUrls }));
  publish = presentation.publish;
  let request: { client: GatewayBrowserClient; controller: AbortController } | null = null;
  let disposed = false;
  const icons = new PluginIconOwner({
    getFetchContext: () => pluginIconFetchContext(hooks.getContext()),
    isConnected: hooks.isConnected,
    onUrlsChange: (urls) => {
      iconUrls = urls;
      if (!disposed) {
        publish();
      }
    },
  });
  const pluginIconUrls = createMemo(() => {
    const projected = presentation.read();
    const plugins = projected.catalog?.plugins;
    return Object.fromEntries(
      plugins
        ? hooks.getChannelIds().flatMap((channelId) => {
            const plugin = resolveChannelIconOwner(plugins, channelId);
            const url = plugin ? projected.iconUrls[plugin.id] : undefined;
            return url === undefined ? [] : [[channelId, url] as const];
          })
        : [],
    );
  });

  function loadIcons(result: PluginListResult) {
    for (const channelId of hooks.getChannelIds()) {
      const plugin = resolveChannelIconOwner(result.plugins, channelId);
      if (plugin && !iconUrls[plugin.id] && !icons.isLoading(plugin.id)) {
        // A later channel refresh retries missing artwork.
        icons.invalidate(plugin.id);
        icons.load(plugin.id);
      }
    }
  }

  function ensure(client: GatewayBrowserClient | null) {
    const snapshot = hooks.getContext().gateway.snapshot;
    if (!client || snapshot.phase !== "connected") {
      return;
    }
    if (!hasOperatorReadAccess(snapshot.hello?.auth ?? null)) {
      reset();
      return;
    }
    if (catalog) {
      loadIcons(catalog);
      return;
    }
    if (request?.client === client) {
      return;
    }
    request?.controller.abort();
    const current = { client, controller: new AbortController() };
    request = current;
    void client
      .request<PluginListResult>("plugins.list", {}, { signal: current.controller.signal })
      .then((result) => {
        if (request !== current || hooks.getContext().gateway.snapshot.client !== client) {
          return;
        }
        catalog = result;
        publish();
        loadIcons(result);
      })
      .catch(() => {
        // Channel status metadata remains a complete fallback when catalog loading fails.
      })
      .finally(() => {
        if (request === current) {
          request = null;
        }
      });
  }

  function invalidateRequests() {
    request?.controller.abort();
    request = null;
    icons.reconcileKeys(new Set(Object.keys(iconUrls)));
  }

  function reset() {
    details.reset();
    invalidateRequests();
    catalog = null;
    icons.reset();
  }
  onCleanup(() => {
    disposed = true;
    reset();
  });
  return {
    details,
    ensure,
    invalidateRequests,
    reset,
    get pluginCatalog() {
      return presentation.read().catalog;
    },
    get pluginIconUrls() {
      return pluginIconUrls();
    },
  };
}
