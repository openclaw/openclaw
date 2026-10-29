import { createMemo, createSignal, onCleanup } from "solid-js";
import { isKnownCoreToolId } from "../../../../src/agents/core-tool-facts.ts";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { fetchPluginActivityIconBlobUrl, fetchPluginIconBlobUrl } from "../plugins/icon-loader.ts";
import { PluginIconOwner } from "../plugins/plugin-icon-owner.ts";

type PluginToolIcon = { url: string; branding?: boolean; onError: () => void };
export type PluginToolIcons = Pick<ReadonlyMap<string, PluginToolIcon>, "get">;

type ToolIconSource = {
  context: Pick<ApplicationContext, "resourceBasePath"> & {
    gateway: Pick<ApplicationContext["gateway"], "snapshot" | "connection" | "connectionRevision">;
  };
  session: { sessionKey: string; agentId?: string } | undefined;
};

export function createChatToolIcons(readSource: () => ToolIconSource): PluginToolIcons {
  const readBinding = () => {
    const { context, session } = readSource();
    const { snapshot, connectionRevision: revision } = context.gateway;
    return snapshot.phase === "connected" && snapshot.client && session
      ? { client: snapshot.client, session, revision }
      : null;
  };
  type Binding = ReturnType<typeof readBinding>;
  const sameBinding = (a: Binding, b: Binding) =>
    a?.client === b?.client &&
    a?.revision === b?.revision &&
    a?.session.sessionKey === b?.session.sessionKey &&
    a?.session.agentId === b?.session.agentId;
  const binding = createMemo(readBinding, { equals: sameBinding });
  const icons = createMemo(() => {
    const current = binding();
    if (!current) {
      return undefined;
    }
    const owner: NonNullable<Binding> & {
      controller: AbortController;
      plugins?: Promise<PluginListResult>;
      loading?: boolean;
    } = { ...current, controller: new AbortController() };
    let disposed = false;
    const [toolKeys, setToolKeys] = createSignal(new Map<string, string[]>());
    const [urls, setUrls] = createSignal<Record<string, string>>({});
    const artwork = new Map<string, { pluginId: string; tool?: string; branding: boolean }>();
    // Request admission must see same-turn misses before Solid publishes icon data.
    const known = new Set<string>();
    const requested = new Set<string>();
    const pending = new Set<string>();
    const isCurrent = () => !disposed && sameBinding(owner, readBinding());
    const loader = new PluginIconOwner({
      getFetchContext: () => {
        const {
          context: { gateway, resourceBasePath },
        } = readSource();
        return {
          resourceBasePath,
          gatewayUrl: gateway.connection.gatewayUrl,
          auth: {
            hello: gateway.snapshot.hello,
            settings: { token: gateway.connection.token },
            password: gateway.connection.password,
          },
        };
      },
      isConnected: isCurrent,
      fetchIcon: (key, context, signal) => {
        const icon = artwork.get(key);
        return icon
          ? icon.branding
            ? fetchPluginIconBlobUrl({ ...context, pluginId: icon.pluginId, signal })
            : fetchPluginActivityIconBlobUrl({ ...context, ...icon, signal })
          : Promise.resolve(null);
      },
      // Failed reads reveal the next candidate even when no URL was published.
      onUnavailable: () => setUrls((previous) => ({ ...previous })),
      onUrlsChange: (next) => {
        if (!disposed) {
          setUrls(next);
        }
      },
    });
    // Computation cleanup retires requests without publishing presentation state.
    onCleanup(() => {
      disposed = true;
      owner.controller.abort();
      loader.reset();
    });

    function refresh() {
      const active = owner;
      if (!isCurrent() || active.loading || pending.size === 0) {
        return;
      }
      // Remember misses and core/iconless tools. Newly displayed names refresh inventory.
      for (const name of pending) {
        known.add(name);
      }
      pending.clear();
      active.loading = true;
      const options = { signal: active.controller.signal };
      void Promise.all([
        active.client.request<ToolsEffectiveResult>("tools.effective", active.session, options),
        (active.plugins ??= active.client
          .request<PluginListResult>("plugins.list", {}, options)
          .catch((error: unknown) => {
            // A later newly displayed tool can recover metadata after a failed read.
            active.plugins = undefined;
            throw error;
          })),
      ])
        .then(([tools, plugins]) => {
          if (!isCurrent()) {
            return;
          }
          const availableIcons = new Map(
            plugins.plugins.map((plugin) => [
              plugin.id,
              {
                branding: plugin.hasToolBrandIcon,
                default: plugin.hasActivityIcon,
                tools: new Set(plugin.activityIconTools),
              },
            ]),
          );
          const keys = new Map<string, string[]>();
          artwork.clear();
          // Effective inventory retains plugin ownership for built-ins such as Browser and Canvas.
          for (const group of tools.groups) {
            for (const tool of group.tools) {
              const pluginId = tool.pluginId;
              const available = pluginId ? availableIcons.get(pluginId) : undefined;
              const override = available?.tools.has(tool.id) ? tool.id : undefined;
              const candidates: string[] = [];
              // Shared capabilities keep their semantic glyph, independent of provider artwork.
              if (pluginId && tool.source !== "core") {
                if (available?.branding && !isKnownCoreToolId(tool.id)) {
                  const key = JSON.stringify([pluginId, "brand"]);
                  artwork.set(key, { pluginId, branding: true });
                  candidates.push(key);
                }
                if (override || available?.default) {
                  const key = JSON.stringify([pluginId, "activity", override ?? null]);
                  artwork.set(key, { pluginId, tool: override, branding: false });
                  candidates.push(key);
                }
              }
              keys.set(tool.id, candidates);
              known.add(tool.id);
              pending.delete(tool.id);
            }
          }
          setToolKeys((previous) => new Map([...previous, ...keys]));
          loader.reconcileKeys(new Set(artwork.keys()));
          for (const name of requested) {
            const key = keys.get(name)?.[0];
            if (key) {
              loader.load(key);
            }
          }
        })
        .catch(() => {
          // Optional presentation keeps the existing symbol after a failed lookup.
        })
        .finally(() => {
          if (disposed) {
            return;
          }
          active.loading = false;
          refresh();
        });
    }

    return {
      get(name: string) {
        const keys = toolKeys();
        const images = urls();
        if (!isCurrent()) {
          return undefined;
        }
        requested.add(name);
        if (!known.has(name)) {
          const scheduled = pending.size > 0;
          pending.add(name);
          if (!scheduled) {
            queueMicrotask(refresh);
          }
        }
        for (const key of keys.get(name) ?? []) {
          if (loader.isUnavailable(key)) {
            continue;
          }
          loader.load(key);
          const url = images[key];
          return url
            ? { url, branding: artwork.get(key)?.branding, onError: () => loader.handleError(key) }
            : undefined;
        }
        return undefined;
      },
    };
  });
  return { get: (name) => icons()?.get(name) };
}
