import type { ReactiveControllerHost } from "lit";
import type {
  PluginControlUiEntryPoint,
  PluginsUiEntryPointLaunchResult,
  PluginsUiEntryPointsResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationGatewaySnapshot, ApplicationNavigationOptions } from "../app/context.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import {
  navigateReservedExternalWindow,
  openExternalUrlSafe,
  reserveExternalWindow,
} from "../lib/open-external-url.ts";
import { pluginEntryPointSearch } from "../pages/plugin/route.ts";

type LaunchContext = {
  contextTokens?: number;
  navigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  sessionKey?: string;
};

export function resolveSidebarContextTokens(
  sessions: SessionsListResult | null,
  sessionKey: string,
): number | undefined {
  const activeSession = sessions?.sessions.find((row) => row.key === sessionKey);
  const contextTokens = activeSession?.contextTokens ?? sessions?.defaults?.contextTokens;
  return typeof contextTokens === "number" && contextTokens > 0 ? contextTokens : undefined;
}

export class SidebarPluginUiEntryController {
  entryPoints: PluginControlUiEntryPoint[] = [];
  private client: GatewayBrowserClient | null = null;
  private connected = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getLaunchContext: () => LaunchContext,
  ) {}

  setGateway(
    snapshot: ApplicationGatewaySnapshot,
    client: GatewayBrowserClient | null,
    connected: boolean,
  ): void {
    this.client = client;
    this.connected = connected;
    this.entryPoints = [];
    this.host.requestUpdate();
    if (client && connected && isGatewayMethodAdvertised(snapshot, "plugins.uiEntryPoints")) {
      void this.load(client);
    }
  }

  private async load(client: GatewayBrowserClient): Promise<void> {
    try {
      const result = (await client.request(
        "plugins.uiEntryPoints",
        {},
      )) as PluginsUiEntryPointsResult;
      if (this.client === client && this.connected) {
        this.entryPoints = Array.isArray(result.entryPoints) ? result.entryPoints : [];
        this.host.requestUpdate();
      }
    } catch {
      if (this.client === client) {
        this.entryPoints = [];
        this.host.requestUpdate();
      }
    }
  }

  activate(entryPoint: PluginControlUiEntryPoint): void {
    const openMode = entryPoint.openMode ?? "in-app";
    const context = this.getLaunchContext();
    if (openMode === "in-app") {
      context.navigate?.("plugin", {
        search: pluginEntryPointSearch({ entryPoint: true, ...entryPoint }),
      });
      return;
    }
    const reservedWindow = openMode === "new-window" ? reserveExternalWindow() : null;
    void this.launch(entryPoint, context, reservedWindow).then((path) => {
      if (!path) {
        return;
      }
      if (openMode === "new-window") {
        if (reservedWindow) {
          navigateReservedExternalWindow(reservedWindow, path);
        } else {
          openExternalUrlSafe(path);
        }
        return;
      }
      window.location.assign(path);
    });
  }

  private async launch(
    entryPoint: PluginControlUiEntryPoint,
    context: LaunchContext,
    reservedWindow: WindowProxy | null,
  ): Promise<string | null> {
    const client = this.client;
    if (!client) {
      reservedWindow?.close();
      return null;
    }
    try {
      const result = (await client.request("plugins.uiEntryPointLaunch", {
        id: entryPoint.id,
        pluginId: entryPoint.pluginId,
        path: entryPoint.path,
        ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
        ...(context.contextTokens ? { contextTokens: context.contextTokens } : {}),
      })) as PluginsUiEntryPointLaunchResult;
      return result.path;
    } catch {
      reservedWindow?.close();
      return null;
    }
  }
}
