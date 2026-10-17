import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { fetchPluginActivityIconBlobUrl } from "../plugins/icon-loader.ts";
import { PluginIconController } from "../plugins/plugin-icon-controller.ts";

type PluginToolIcon = { url: string; onError: () => void };
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
  let owner:
    | (NonNullable<Binding> & {
        controller: AbortController;
        plugins?: Promise<PluginListResult>;
        loading?: boolean;
      })
    | null = null;
  const [toolKeys, setToolKeys] = createSignal(new Map<string, string | undefined>());
  const [urls, setUrls] = createSignal<Record<string, string>>({});
  const activityIcons = new Map<string, { pluginId: string; tool?: string }>();
  // Request admission must see same-turn misses before Solid publishes icon data.
  const known = new Set<string>();
  const requested = new Set<string>();
  const pending = new Set<string>();
  // Late responses check synchronous authority without subscribing their callbacks.
  const isCurrent = () => owner !== null && sameBinding(owner, untrack(readBinding));
  const loader = new PluginIconController({
    getFetchContext: () => {
      // Fetch credentials do not add render dependencies beyond the current binding.
      const {
        context: { gateway, resourceBasePath },
      } = untrack(readSource);
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
      const icon = activityIcons.get(key);
      return icon
        ? fetchPluginActivityIconBlobUrl({ ...context, ...icon, signal })
        : Promise.resolve(null);
    },
    onUrlsChange: (next) => {
      if (owner) {
        setUrls(next);
      }
    },
  });
  // The binding owns abortable icon requests and blob URL retirement.
  createEffect(binding, (next) => {
    if (!next) {
      return undefined;
    }
    owner = { ...next, controller: new AbortController() };
    setToolKeys(new Map());
    setUrls({});
    return () => {
      owner?.controller.abort();
      owner = null;
      activityIcons.clear();
      known.clear();
      requested.clear();
      pending.clear();
      // Resource teardown must not publish into the disposed presentation owner.
      loader.reset();
    };
  });

  function refresh() {
    const active = owner;
    if (!active || !isCurrent() || active.loading || pending.size === 0) {
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
        if (owner !== active || !isCurrent()) {
          return;
        }
        const availableIcons = new Map(
          plugins.plugins.map((plugin) => [
            plugin.id,
            { default: plugin.hasActivityIcon, tools: new Set(plugin.activityIconTools) },
          ]),
        );
        const keys = new Map<string, string | undefined>();
        activityIcons.clear();
        // Effective inventory retains plugin ownership for built-ins such as Browser and Canvas.
        for (const group of tools.groups) {
          for (const tool of group.tools) {
            const pluginId = tool.pluginId;
            const available = pluginId ? availableIcons.get(pluginId) : undefined;
            const override = available?.tools.has(tool.id) ? tool.id : undefined;
            const key =
              pluginId && (override || available?.default)
                ? JSON.stringify([pluginId, override ?? null])
                : undefined;
            if (key && pluginId) {
              activityIcons.set(key, { pluginId, tool: override });
            }
            keys.set(tool.id, key);
            known.add(tool.id);
            pending.delete(tool.id);
          }
        }
        setToolKeys((previous) => new Map([...previous, ...keys]));
        loader.reconcileKeys(new Set(activityIcons.keys()));
        for (const name of requested) {
          const key = keys.get(name);
          if (key) {
            loader.load(key);
          }
        }
      })
      .catch(() => {
        // Optional presentation keeps the existing symbol after a failed lookup.
      })
      .finally(() => {
        if (owner !== active) {
          return;
        }
        active.loading = false;
        refresh();
      });
  }

  return {
    get(name) {
      const current = binding();
      const keys = toolKeys();
      const images = urls();
      if (!current || !isCurrent()) {
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
      const key = keys.get(name);
      if (!key) {
        return undefined;
      }
      loader.load(key);
      const url = images[key];
      return url ? { url, onError: () => loader.handleError(key) } : undefined;
    },
  };
}
