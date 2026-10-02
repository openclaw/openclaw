import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { fetchPluginActivityIconBlobUrl } from "../plugins/icon-loader.ts";
import { PluginIconController } from "../plugins/plugin-icon-controller.ts";

export type PluginToolIcon = { url: string; onError: () => void };
export type PluginToolIcons = Pick<ReadonlyMap<string, PluginToolIcon>, "get">;

type ToolIconSession = { sessionKey: string; agentId?: string };

export class ChatToolIconController implements ReactiveController {
  icons: PluginToolIcons = { get: (name) => this.getIcon(name) };
  private owner: {
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
    session: ToolIconSession;
    revision: number;
    controller: AbortController;
    plugins?: Promise<PluginListResult>;
    loading?: boolean;
  } | null = null;
  private readonly toolIcons = new Map<string, string | undefined>();
  private readonly activityIcons = new Map<string, { pluginId: string; tool?: string }>();
  private readonly requested = new Set<string>();
  private readonly pending = new Set<string>();
  private urls: Record<string, string> = {};
  private readonly loader: PluginIconController;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getContext: () => Pick<ApplicationContext, "resourceBasePath"> & {
      gateway: Pick<
        ApplicationContext["gateway"],
        "snapshot" | "connection" | "connectionRevision"
      >;
    },
    private readonly getSession: () => ToolIconSession | undefined,
  ) {
    host.addController(this);
    this.loader = new PluginIconController({
      getFetchContext: () => {
        const { gateway, resourceBasePath } = getContext();
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
      isConnected: () => this.isCurrent(),
      fetchIcon: (key, context, signal) => {
        const icon = this.activityIcons.get(key);
        return icon
          ? fetchPluginActivityIconBlobUrl({ ...context, ...icon, signal })
          : Promise.resolve(null);
      },
      onUrlsChange: (urls) => this.publish(urls),
    });
  }

  private publish(urls = this.urls) {
    this.urls = urls;
    this.icons = { get: (name) => this.getIcon(name) };
    this.host.requestUpdate();
  }

  private getIcon(name: string): PluginToolIcon | undefined {
    const owner = this.owner;
    if (!owner || !this.isCurrent()) {
      return undefined;
    }
    this.requested.add(name);
    if (!this.toolIcons.has(name)) {
      const scheduled = this.pending.size > 0;
      this.pending.add(name);
      if (!scheduled) {
        queueMicrotask(() => this.refresh());
      }
    }
    const iconKey = this.toolIcons.get(name);
    if (!iconKey) {
      return undefined;
    }
    this.loader.load(iconKey);
    const url = this.urls[iconKey];
    return url
      ? {
          url,
          onError: () => {
            // Removed images can fail after reconnect; only the current owner
            // and URL may retire the replacement plugin's image.
            if (this.owner === owner && this.isCurrent() && this.urls[iconKey] === url) {
              this.loader.handleError(iconKey);
            }
          },
        }
      : undefined;
  }

  private isCurrent() {
    const { snapshot, connectionRevision } = this.getContext().gateway;
    const session = this.getSession();
    return Boolean(
      this.owner &&
      snapshot.phase === "connected" &&
      snapshot.client === this.owner.client &&
      connectionRevision === this.owner.revision &&
      session?.sessionKey === this.owner.session.sessionKey &&
      session?.agentId === this.owner.session.agentId,
    );
  }

  hostUpdate() {
    if (this.isCurrent()) {
      return;
    }
    const { snapshot, connectionRevision: revision } = this.getContext().gateway;
    const { client, phase } = snapshot;
    const session = this.getSession();
    this.hostDisconnected();
    if (phase === "connected" && client && session) {
      this.owner = { client, session, revision, controller: new AbortController() };
      this.publish();
    }
  }

  private refresh() {
    const owner = this.owner;
    if (!owner || !this.isCurrent() || owner.loading || this.pending.size === 0) {
      return;
    }
    // Remember misses as well as core/iconless tools. Only newly rendered names
    // refresh the inventory, including names arriving while a request is active.
    for (const name of this.pending) {
      this.toolIcons.set(name, undefined);
    }
    this.pending.clear();
    owner.loading = true;
    const options = { signal: owner.controller.signal };
    void Promise.all([
      owner.client.request<ToolsEffectiveResult>("tools.effective", owner.session, options),
      (owner.plugins ??= owner.client
        .request<PluginListResult>("plugins.list", {}, options)
        .catch((error: unknown) => {
          // A later newly displayed tool can recover metadata after a failed read.
          owner.plugins = undefined;
          throw error;
        })),
    ])
      .then(([tools, plugins]) => {
        if (this.owner !== owner || !this.isCurrent()) {
          return;
        }
        const availableIcons = new Map(
          plugins.plugins.map((plugin) => [
            plugin.id,
            { default: plugin.hasActivityIcon, tools: new Set(plugin.activityIconTools) },
          ]),
        );
        this.activityIcons.clear();
        // Effective inventory retains plugin ownership for built-ins such as
        // Browser and Canvas that the static catalog groups with core tools.
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
              this.activityIcons.set(key, { pluginId, tool: override });
            }
            this.toolIcons.set(tool.id, key);
            this.pending.delete(tool.id);
          }
        }
        this.loader.reconcileKeys(new Set(this.activityIcons.keys()));
        for (const name of this.requested) {
          const key = this.toolIcons.get(name);
          if (key) {
            this.loader.load(key);
          }
        }
        this.publish();
      })
      .catch(() => {
        // Optional presentation keeps the existing symbol after a failed lookup.
      })
      .finally(() => {
        if (this.owner !== owner) {
          return;
        }
        owner.loading = false;
        this.refresh();
      });
  }

  hostDisconnected() {
    if (!this.owner) {
      return;
    }
    this.owner.controller.abort();
    this.owner = null;
    this.toolIcons.clear();
    this.activityIcons.clear();
    this.requested.clear();
    this.pending.clear();
    this.loader.reset();
  }
}
