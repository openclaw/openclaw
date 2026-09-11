import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
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
  private readonly toolOwners = new Map<string, string | undefined>();
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
    if (!this.toolOwners.has(name)) {
      const scheduled = this.pending.size > 0;
      this.pending.add(name);
      if (!scheduled) {
        queueMicrotask(() => this.refresh());
      }
    }
    const pluginId = this.toolOwners.get(name);
    if (!pluginId) {
      return undefined;
    }
    this.loader.load(pluginId);
    const url = this.urls[pluginId];
    return url
      ? {
          url,
          onError: () => {
            // Removed images can fail after reconnect; only the current owner
            // and URL may retire the replacement plugin's image.
            if (this.owner === owner && this.isCurrent() && this.urls[pluginId] === url) {
              this.loader.handleError(pluginId);
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
      this.toolOwners.set(name, undefined);
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
        const iconIds = new Set(
          plugins.plugins.filter((plugin) => plugin.hasIcon).map((plugin) => plugin.id),
        );
        // Effective inventory retains plugin ownership for built-ins such as
        // Browser and Canvas that the static catalog groups with core tools.
        for (const group of tools.groups) {
          for (const tool of group.tools) {
            this.toolOwners.set(
              tool.id,
              tool.pluginId && iconIds.has(tool.pluginId) ? tool.pluginId : undefined,
            );
            this.pending.delete(tool.id);
          }
        }
        for (const name of this.requested) {
          const pluginId = this.toolOwners.get(name);
          if (pluginId) {
            this.loader.load(pluginId);
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
    this.toolOwners.clear();
    this.requested.clear();
    this.pending.clear();
    this.loader.reset();
  }
}
