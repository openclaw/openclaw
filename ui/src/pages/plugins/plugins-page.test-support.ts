import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent, flush } from "solid-js";
import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PluginsPage } from "./plugins-page.tsx";
import type { PluginsRouteData } from "./route-data.ts";

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

const PLUGINS_GATEWAY_HELLO = gatewayHelloForMethods([
  "config.set",
  "plugins.inspect",
  "plugins.install",
  "plugins.list",
  "plugins.reload",
  "plugins.setEnabled",
  "plugins.uninstall",
]);

type GatewayHarness = {
  gateway: ApplicationGateway;
  publishPlugins: () => void;
  emit: (
    client: GatewayBrowserClient | null,
    connected: boolean,
    overrides?: Partial<ApplicationGatewaySnapshot>,
  ) => ApplicationGatewaySnapshot;
};

type TestPluginsPage = HTMLElement & {
  surface: "discovery" | "settings";
  routeData?: PluginsRouteData;
  readonly updateComplete: Promise<boolean>;
};

export type RuntimeConfigTestState = {
  connected?: boolean;
  configFormDirty: boolean;
  lastError: string | null;
  configSnapshot?: { sourceConfig: Record<string, unknown>; hash: string } | null;
};

export function createPlugin(overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return {
    id: "workboard",
    name: "Workboard",
    description: t("subtitles.workboard"),
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    featured: true,
    order: 10,
    ...overrides,
  };
}

export function createResult(
  pluginOrPlugins: PluginCatalogItem | PluginCatalogItem[] = createPlugin(),
): PluginListResult {
  return {
    plugins: Array.isArray(pluginOrPlugins) ? pluginOrPlugins : [pluginOrPlugins],
    diagnostics: [],
    mutationAllowed: true,
  };
}

export function createDiscoveryDetail(plugin = createPlugin()): PluginDiscoveryDetailResult {
  return {
    plugin: {
      id: `catalog:${plugin.id}`,
      catalog: {
        name: plugin.name,
        family: "code-plugin",
        official: plugin.origin === "official",
        categories: [],
      },
      local: {
        pluginId: plugin.installed ? plugin.id : undefined,
        present: plugin.installed,
        installed: plugin.installed,
        enabled: plugin.enabled,
        state: plugin.state,
        action: plugin.installed ? "manage" : "install",
        install: plugin.install,
      },
    },
    detail: {
      origin: "clawhub",
      packageName: plugin.packageName ?? plugin.id,
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [],
      versions: [],
    },
  };
}

export function createInspectResult(
  overrides: Partial<PluginsInspectResult> = {},
): PluginsInspectResult {
  return {
    ok: true,
    reviewToken: "review-token-workboard",
    plugin: {
      id: "workboard",
      name: "Workboard",
      origin: "global",
      installed: true,
      enabled: false,
    },
    source: { kind: "npm", packageName: "workboard" },
    declared: {
      channels: [],
      providers: [],
      tools: [],
      contracts: [],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    },
    components: {
      mapped: [],
      skills: [],
      mcpServers: [],
      commands: [],
      hooks: [],
      lspServers: [],
      unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: true },
        allowConversationAccess: { effective: false },
      },
    },
    ...overrides,
  };
}

export function createPluginsRouteLocation(url = "/settings/plugins"): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

export function createPluginsRouteData(
  gateway: ApplicationGateway,
  result: PluginListResult | null = createResult(),
  location = createPluginsRouteLocation(),
): PluginsRouteData {
  return { gateway, gatewaySnapshot: gateway.snapshot, location, result, error: null };
}

export function createClient(handler: RequestHandler) {
  const request = vi.fn(handler);
  return {
    client: { request, addEventListener: () => () => {} } as unknown as GatewayBrowserClient,
    request,
  };
}

function createSnapshot(
  client: GatewayBrowserClient | null,
  connected: boolean,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: PLUGINS_GATEWAY_HELLO,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

export function createGateway(client: GatewayBrowserClient, connected = true): GatewayHarness {
  let snapshot = createSnapshot(client, connected);
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://localhost", token: "", password: "", bootstrapToken: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    loadSelfProfile: async () => null,
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } satisfies ApplicationGateway;
  return {
    gateway,
    publishPlugins() {
      snapshot = {
        ...snapshot,
        pluginCapabilities: {
          ok: true,
          generation: (snapshot.pluginCapabilities?.generation ?? 0) + 1,
          descriptors: [],
          methods: snapshot.hello?.features?.methods ?? [],
          controlUiTabs: [],
          controlUiWidgetKinds: [],
          pluginSurfaceUrls: {},
        },
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    emit(nextClient, nextConnected, overrides = {}) {
      snapshot = { ...createSnapshot(nextClient, nextConnected), ...overrides };
      for (const listener of listeners) {
        listener(snapshot);
      }
      return snapshot;
    },
  };
}

type RuntimeConfigTestHarness = {
  runtimeConfig: {
    state: RuntimeConfigTestState;
    canSet: boolean;
    refresh: ApplicationContext["runtimeConfig"]["refresh"];
    ensureLoaded: ReturnType<typeof vi.fn<() => Promise<undefined>>>;
    ensureSchemaLoaded: ReturnType<typeof vi.fn<() => Promise<undefined>>>;
    refreshSchema: ReturnType<typeof vi.fn<() => Promise<undefined>>>;
    retry: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
    patch: ReturnType<
      typeof vi.fn<(options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>>
    >;
    patchForm: ReturnType<typeof vi.fn<ApplicationContext["runtimeConfig"]["patchForm"]>>;
    removeFormValue: ReturnType<
      typeof vi.fn<ApplicationContext["runtimeConfig"]["removeFormValue"]>
    >;
    save: ReturnType<typeof vi.fn<ApplicationContext["runtimeConfig"]["save"]>>;
    flushFormChanges: ReturnType<
      typeof vi.fn<ApplicationContext["runtimeConfig"]["flushFormChanges"]>
    >;
    patchFromSnapshot: ApplicationContext["runtimeConfig"]["patchFromSnapshot"];
    runExternalMutation: ApplicationContext["runtimeConfig"]["runExternalMutation"];
    subscribe: (listener: (state: RuntimeConfigTestState) => void) => () => void;
  };
  notify: () => void;
};

export function createRuntimeConfigHarness(
  refreshConfig: ApplicationContext["runtimeConfig"]["refresh"],
  runtimeConfigState: RuntimeConfigTestState,
  getClient?: () => GatewayBrowserClient | null,
): RuntimeConfigTestHarness {
  const listeners = new Set<(state: RuntimeConfigTestState) => void>();
  const patch = vi.fn<
    (options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>
  >(async () => true);
  const patchForm = vi.fn<(path: Array<string | number>, value: unknown) => void>();
  const removeFormValue = vi.fn<(path: Array<string | number>) => void>();
  const save = vi.fn(async () => true);
  const runtimeConfig = {
    // Keep the fixture identity used by autosave notifications, with the owner's real defaults.
    state: Object.assign(runtimeConfigState, {
      ...createInitialConfigState(),
      ...runtimeConfigState,
    }),
    canSet: true,
    refresh: refreshConfig,
    ensureLoaded: vi.fn(async () => undefined),
    ensureSchemaLoaded: vi.fn(async () => undefined),
    refreshSchema: vi.fn(async () => undefined),
    retry: vi.fn(async () => true),
    patch,
    patchForm,
    removeFormValue,
    save,
    flushFormChanges: vi.fn(async () => true),
    patchFromSnapshot: vi.fn(async (build) => {
      const config = runtimeConfigState.configSnapshot?.sourceConfig ?? {};
      const built = build(config);
      if ("error" in built) {
        runtimeConfigState.lastError = built.error;
        return false;
      }
      return patch(built.options);
    }),
    runExternalMutation: vi.fn(async (task) => {
      const client = getClient?.() ?? null;
      if (!client) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: "Configuration is unavailable; reconnect and try again.",
        };
      }
      try {
        const value = await task(client);
        try {
          await refreshConfig();
          return { ok: true as const, value, refresh: { ok: true as const } };
        } catch (error) {
          return {
            ok: true as const,
            value,
            refresh: {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      } catch (error) {
        return {
          ok: false as const,
          reason: "error" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
    subscribe(listener: (state: RuntimeConfigTestState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    runtimeConfig,
    notify: () => {
      for (const listener of listeners) {
        listener(runtimeConfigState);
      }
    },
  };
}

export function createContext(
  gateway: ApplicationGateway,
  refreshConfig: ApplicationContext["runtimeConfig"]["refresh"] = vi.fn(async () => undefined),
  runtimeConfigState: RuntimeConfigTestState = {
    configFormDirty: false,
    lastError: null,
  },
  harness = createRuntimeConfigHarness(
    refreshConfig,
    runtimeConfigState,
    () => gateway.snapshot.client,
  ),
): ApplicationContext {
  return {
    gateway,
    basePath: "",
    resourceBasePath: "",
    runtimeConfig: harness.runtimeConfig,
    navigate: vi.fn(),
    replace: vi.fn(),
  } as unknown as ApplicationContext;
}

export async function settlePlugins(): Promise<boolean> {
  flush();
  await Promise.resolve();
  flush();
  await Promise.resolve();
  flush();
  return true;
}

export async function mountPage(
  context: ApplicationContext,
  routeData?: PluginsRouteData,
  surface: TestPluginsPage["surface"] = routeData?.location.pathname.includes("/settings/plugins")
    ? "settings"
    : "discovery",
): Promise<{ page: TestPluginsPage }> {
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => createComponent(PluginsPage, { routeData, surface }), {
    wrapper: provider.wrapper,
  });
  await settlePlugins();
  const page = mounted.container.querySelector("openclaw-plugins-page") as TestPluginsPage;
  if (!page) {
    throw new Error("Plugins page did not render its host element");
  }
  page.remove = () => mounted.unmount();
  return { page };
}

export async function clickPluginAction(page: HTMLElement, label: string): Promise<void> {
  const button = await waitForSolid(() => {
    const control = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) =>
        element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
    );
    if (!control) {
      throw new Error(`No plugin action matching ${label}`);
    }
    return control;
  });
  button.click();
  await settlePlugins();
}

export function resetPluginsPageTestState(): void {
  cleanupSolid();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
