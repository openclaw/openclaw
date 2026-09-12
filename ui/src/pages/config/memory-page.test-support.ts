import { ContextProvider } from "@lit/context";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
  type ApplicationNavigationOptions,
} from "../../app/context.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { setPluginEnabled, type PluginCatalogItem } from "../../lib/plugins/index.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { configRouteData, type ConfigRouteData } from "./route-data.ts";

type MemoryPageElement = HTMLElement & {
  configObject: Record<string, unknown>;
  routeData: ConfigRouteData | null;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

export function memoryRoute(url: string): ConfigRouteData {
  const parsed = new URL(url, "https://control.test");
  return configRouteData({ pathname: parsed.pathname, search: parsed.search, hash: parsed.hash });
}

export function memoryTabRoute(tab: "overview" | "memories" | "dreams" | "settings") {
  return memoryRoute(`/settings/memory${tab === "overview" ? "" : `/${tab}`}`);
}

export function createMemoryTestEngine(id: string, enabled: boolean, name = id): PluginCatalogItem {
  return {
    id,
    name,
    installed: true,
    enabled,
    state: enabled ? "enabled" : "disabled",
    kind: ["memory"],
  };
}

export function createMemoryTestAddon(id: string, enabled: boolean): PluginCatalogItem {
  return {
    id,
    name: id,
    installed: true,
    enabled,
    state: enabled ? "enabled" : "disabled",
  };
}

export function createMemoryTestMutationResult(
  pluginId: string,
  enabled: boolean,
  warnings: string[] = [],
  generation = 1,
): Awaited<ReturnType<typeof setPluginEnabled>> {
  return {
    ok: true,
    plugin: createMemoryTestAddon(pluginId, enabled),
    restartRequired: false,
    runtime: { operationId: `${pluginId}-${generation}`, generation, pluginIds: [pluginId] },
    warnings,
  };
}

export function createMemoryPage(params: {
  configObject: Record<string, unknown>;
  listCatalog?: (
    call: number,
  ) => Promise<{ plugins: readonly PluginCatalogItem[]; mutationAllowed?: boolean }>;
  catalog?: readonly PluginCatalogItem[];
  mutationAllowed?: boolean;
  patchForm?: (path: Array<string | number>, value: unknown) => void;
  waitForPendingWrites?: () => Promise<void>;
  setEnabled?: (pluginId: string, enabled: boolean) => Promise<unknown>;
  refresh?: () => Promise<void>;
  navigate?: (routeId: string, options?: ApplicationNavigationOptions) => void;
  replace?: (routeId: string, options?: ApplicationNavigationOptions) => void;
  routeData?: ConfigRouteData;
  basePath?: string;
  agents?: Array<{ id: string; name?: string }>;
  memoryStatus?: (agentId: string, probe: boolean) => Promise<unknown>;
  processInfo?: (call: number) => Promise<{ processInstanceId?: string }>;
  scopes?: string[];
  lookupSchemaPath?: (call: number) => Promise<unknown>;
}) {
  let listCalls = 0;
  let schemaLookups = 0;
  let systemInfoCalls = 0;
  const request = vi.fn((method: string, payload?: unknown) => {
    if (method === "plugins.list") {
      const result: Promise<{
        plugins: readonly PluginCatalogItem[];
        mutationAllowed?: boolean;
      }> = params.listCatalog
        ? params.listCatalog(listCalls++)
        : Promise.resolve({ plugins: params.catalog ?? [] });
      return result.then((catalog) => ({
        ...catalog,
        diagnostics: [],
        mutationAllowed: catalog.mutationAllowed ?? params.mutationAllowed ?? true,
      }));
    }
    if (method === "doctor.memory.status") {
      const input = asOptionalRecord(payload);
      const agentId = typeof input?.agentId === "string" ? input.agentId : "main";
      return params.memoryStatus
        ? params.memoryStatus(agentId, input?.probe === true)
        : Promise.resolve({
            agentId,
            provider: "none",
            embedding: { ok: false, checked: false },
          });
    }
    if (method === "system.info" && params.processInfo) {
      return params.processInfo(systemInfoCalls++);
    }
    return Promise.resolve({});
  });
  vi.mocked(setPluginEnabled).mockImplementation(
    (_client, pluginId, enabled) =>
      (params.setEnabled
        ? params.setEnabled(pluginId, enabled)
        : Promise.resolve(createMemoryTestMutationResult(pluginId, enabled))) as ReturnType<
        typeof setPluginEnabled
      >,
  );
  const runtimeListeners = new Set<() => void>();
  const gatewayHarness = createApplicationGateway({
    client: createTestGatewayClient(request),
    phase: "connected",
    offlineStable: false,
    pluginCapabilities: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    hello: {
      ...gatewayHelloForMethods(params.processInfo ? ["system.info"] : [], params.scopes),
      server: { version: "test", bootId: "memory-boot-a", connId: "memory-connection" },
    },
  });
  const gateway = gatewayHarness.gateway;
  const element = document.createElement("openclaw-memory-settings") as MemoryPageElement;
  element.configObject = params.configObject;
  element.routeData = params.routeData ?? memoryTabRoute("settings");
  let mutationQueue = Promise.resolve();
  const runtimeConfig = {
    state: {
      client: {},
      connected: true,
      configSaving: false,
      configApplying: false,
      configForm: params.configObject,
      configSnapshot: null,
    },
    subscribe: (notify: () => void) => {
      runtimeListeners.add(notify);
      return () => runtimeListeners.delete(notify);
    },
    lookupSchemaPath: vi.fn(() =>
      params.lookupSchemaPath
        ? params.lookupSchemaPath(schemaLookups++)
        : Promise.resolve({ type: "object" }),
    ),
    patchForm: params.patchForm ?? vi.fn(),
    removeFormValue: vi.fn(),
    waitForPendingWrites: params.waitForPendingWrites ?? (() => Promise.resolve()),
    refresh: vi.fn(params.refresh ?? (() => Promise.resolve())),
    runExternalMutation: vi.fn(
      (task: (client: unknown) => Promise<unknown>, options?: { canDispatch?: () => boolean }) => {
        const connection = gateway.snapshot;
        const scope = connectionLifecycle.capture();
        const run = async () => {
          await runtimeConfig.waitForPendingWrites();
          if (
            !scope ||
            !connectionLifecycle.isCurrent(scope) ||
            options?.canDispatch?.() === false
          ) {
            return { ok: false as const, error: "Connection changed before the update started." };
          }
          try {
            const value = await task(connection.client);
            try {
              await runtimeConfig.refresh();
              return { ok: true as const, value, refresh: { ok: true as const } };
            } catch (error) {
              return {
                ok: true as const,
                value,
                refresh: { ok: false as const, error: (error as Error).message },
              };
            }
          } catch (error) {
            return { ok: false as const, error: (error as Error).message };
          }
        };
        const pending = mutationQueue.then(run, run);
        mutationQueue = pending.then(
          () => undefined,
          () => undefined,
        );
        return pending;
      },
    ),
    ensureLoaded: () => Promise.resolve(),
  };
  const context = {
    basePath: params.basePath ?? "",
    gateway,
    runtimeConfig,
    agents: {
      state: {
        agentsList: {
          defaultId: params.agents?.[0]?.id ?? "main",
          agents: params.agents ?? [{ id: "main" }],
        },
        agentsLoading: false,
      },
      subscribe: () => () => undefined,
      ensureList: () => Promise.resolve(),
    },
    navigate: params.navigate ?? vi.fn(),
    replace: params.replace ?? vi.fn(),
  } as unknown as ApplicationContext;
  const connectionLifecycle = createGatewayConnectionLifecycle(context.gateway.snapshot);
  (element as unknown as { context: ApplicationContext }).context = context;
  new ContextProvider(element, { context: applicationContext, initialValue: context }).setValue(
    context,
  );
  const publishGateway = (snapshot: ApplicationGatewaySnapshot) => {
    connectionLifecycle.transition(snapshot);
    gatewayHarness.publish(snapshot);
  };
  const setPhase = (phase: "connected" | "disconnected") => {
    runtimeConfig.state = { ...runtimeConfig.state, connected: phase === "connected" };
    publishGateway({ ...gateway.snapshot, phase: phase === "connected" ? "connected" : "offline" });
    for (const notify of runtimeListeners) {
      notify();
    }
  };
  const publishPluginGeneration = (generation: number) => {
    publishGateway({
      ...gateway.snapshot,
      pluginCapabilities: { ok: true, generation, descriptors: [] },
    });
  };
  const setBootId = (bootId: string | undefined) => {
    const hello = gateway.snapshot.hello;
    if (!hello) {
      throw new Error("Missing Memory fixture hello");
    }
    publishGateway({
      ...gateway.snapshot,
      hello: { ...hello, server: { ...hello.server, bootId } },
    });
  };
  const setScopes = (scopes: string[]) => {
    const hello = gateway.snapshot.hello;
    if (!hello?.auth) {
      throw new Error("Missing Memory fixture auth");
    }
    publishGateway({ ...gateway.snapshot, hello: { ...hello, auth: { ...hello.auth, scopes } } });
  };
  return {
    element,
    request,
    setPhase,
    publishPluginGeneration,
    setBootId,
    setScopes,
    refresh: runtimeConfig.refresh,
    runExternalMutation: runtimeConfig.runExternalMutation,
    lookupSchemaPath: runtimeConfig.lookupSchemaPath,
  };
}

export function createMemoryTestDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export function addonStatus(element: HTMLElement, label: string): string | null {
  const row = [...element.querySelectorAll(".settings-row")].find((entry) =>
    entry.textContent?.includes(label),
  );
  return row?.querySelector(".settings-status")?.textContent?.trim() ?? null;
}

export function addonSwitch(element: HTMLElement, label: string) {
  const row = [...element.querySelectorAll(".settings-row--toggle")].find((entry) =>
    entry.textContent?.includes(label),
  );
  return row?.querySelector<HTMLElement & { checked: boolean }>("wa-switch") ?? null;
}

export function toggleAddon(element: HTMLElement, label: string, checked: boolean) {
  const control = addonSwitch(element, label);
  if (!control) {
    throw new Error(`Missing add-on toggle: ${label}`);
  }
  control.checked = checked;
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

export function activeEngine(element: HTMLElement): string | null {
  return (
    element.querySelector("wa-radio.settings-segmented__btn--active")?.getAttribute("value") ?? null
  );
}

export function selectEngine(element: HTMLElement, value: string) {
  const group = element.querySelector("wa-radio-group") as HTMLElement & { value?: string };
  group.value = value;
  group.dispatchEvent(new Event("change"));
}
