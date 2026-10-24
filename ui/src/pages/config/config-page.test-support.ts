import { createRouter } from "@openclaw/uirouter";
import { createComponent, createSignal } from "solid-js";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createConfigPage } from "./config-page-state.ts";
import { ConfigPage, type ConfigPageId } from "./config-page.tsx";
import type { ConfigRouteData } from "./route-data.ts";

export function createConfigRouteContext(): ApplicationContext {
  const config = { messages: { ackReaction: "!" }, tts: { provider: "synthetic" } };
  const subscribe = () => () => undefined;
  const { gateway } = createApplicationGateway({
    client: null,
    phase: "offline",
    offlineStable: true,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  });
  return {
    basePath: "",
    gateway,
    settingsAgentSelection: { state: { selectedId: "main" }, subscribe },
    agentSelection: { state: { selectedId: "main" }, subscribe },
    agents: { state: { agentsList: null }, subscribe },
    config: {
      current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "test" },
      subscribe,
    },
    runtimeConfig: {
      state: {
        connected: false,
        configLoading: false,
        configSchemaLoading: false,
        configSnapshot: { config, runtimeConfig: config, hash: "settings-defaults" },
        configSchema: {
          type: "object",
          properties: {
            messages: { type: "object", properties: { ackReaction: { type: "string" } } },
            tts: { type: "object", properties: { provider: { type: "string" } } },
          },
        },
        configUiHints: {},
        configForm: config,
        configFormOriginal: config,
        configRaw: JSON.stringify(config),
        configRawOriginal: JSON.stringify(config),
        configValid: true,
        configIssues: [],
      },
      ensureLoaded: async () => undefined,
      ensureSchemaLoaded: async () => undefined,
      subscribe,
    },
    theme: { branding: resolveThemeBranding(undefined), subscribe },
    overlays: { snapshot: {}, subscribe },
    webPush: { snapshot: undefined, subscribe },
  } as unknown as ApplicationContext;
}

const publications = new WeakMap<object, Set<() => void>>();

export function publishConfigSource(source: object) {
  for (const notify of publications.get(source) ?? []) {
    notify();
  }
  flush();
}

function observeFixture(source: { subscribe?: (notify: () => void) => () => void }) {
  if (publications.has(source)) {
    return;
  }
  const listeners = new Set<() => void>();
  publications.set(source, listeners);
  const subscribe = source.subscribe?.bind(source);
  source.subscribe = (notify) => {
    listeners.add(notify);
    const stop = subscribe?.(notify);
    return () => {
      listeners.delete(notify);
      stop?.();
    };
  };
}

/** Fill only missing capabilities in partial page fixtures; real owners retain their identity. */
export function completeConfigContext(context: ApplicationContext): ApplicationContext {
  const subscribe = () => () => undefined;
  Object.assign(context, {
    basePath: context.basePath ?? "",
    router: context.router ?? createRouter({ routes: [] }),
    config: context.config ?? { current: { assistantIdentity: { name: "OpenClaw" } }, subscribe },
    settingsAgentSelection: context.settingsAgentSelection ?? {
      state: { selectedId: "main" },
      subscribe,
    },
    agentSelection: context.agentSelection ?? { state: { selectedId: "main" }, subscribe },
    agents: context.agents ?? { state: { agentsList: null }, subscribe },
    agentIdentity: context.agentIdentity ?? {
      get: () => null,
      ensure: async () => undefined,
      subscribe,
    },
    theme: context.theme ?? {
      branding: resolveThemeBranding(undefined),
      subscribe,
    },
    overlays: context.overlays ?? { snapshot: {}, subscribe },
    runtimeConfig: context.runtimeConfig ?? {
      state: { configSnapshot: null, configSchema: {}, configForm: {}, configRaw: "{}" },
      subscribe,
    },
    webPush: context.webPush ?? { snapshot: {}, subscribe },
  });
  for (const source of [
    context.gateway,
    context.config,
    context.settingsAgentSelection,
    context.agentSelection,
    context.agents,
    context.agentIdentity,
    context.theme,
    context.overlays,
    context.webPush,
    context.runtimeConfig,
    context.router,
  ]) {
    observeFixture(source);
  }
  Object.assign(context.router, {
    getState:
      context.router.getState ?? (() => ({ location: { pathname: "/", search: "", hash: "" } })),
  });
  if (!context.agentIdentity.get) {
    Object.assign(context.agentIdentity, { get: () => null });
  }
  Object.assign(context.config, {
    current: context.config.current ?? { assistantIdentity: { name: "OpenClaw" } },
  });
  Object.assign(context.overlays, { snapshot: context.overlays.snapshot ?? {} });
  Object.assign(context.webPush, { snapshot: context.webPush.snapshot ?? {} });
  if (!context.theme.branding) {
    Object.assign(context.theme, { branding: resolveThemeBranding(undefined) });
  }
  if (!context.theme.settings) {
    Object.defineProperty(context.theme, "settings", { configurable: true, get: loadSettings });
  }
  Object.assign(context.gateway, {
    connection: context.gateway.connection ?? { gatewayUrl: "ws://config.test" },
    subscribeEvents: context.gateway.subscribeEvents ?? subscribe,
  });
  const state = context.runtimeConfig.state;
  const defaults = {
    connected: context.gateway.snapshot.phase === "connected",
    configLoading: false,
    configSchemaLoading: false,
    configSaving: false,
    configApplying: false,
    configFormDirty: false,
    configFormMode: "form",
    configForm: {},
    configFormOriginal: {},
    configRaw: "{}",
    configRawOriginal: "{}",
    configUiHints: {},
    configIssues: [],
    configValid: true,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(state, key)) {
      Object.assign(state, { [key]: value });
    }
  }
  Object.assign(context.runtimeConfig, {
    ensureLoaded: context.runtimeConfig.ensureLoaded ?? (async () => undefined),
    ensureSchemaLoaded: context.runtimeConfig.ensureSchemaLoaded ?? (async () => undefined),
  });
  return context;
}

export function mountConfigPage(
  initialContext: ApplicationContext,
  initial: { pageId?: ConfigPageId; routeData?: ConfigRouteData | null } = {},
) {
  const provider = createSolidApplicationContextProvider(completeConfigContext(initialContext));
  const [props, setProps] = createSignal(initial);
  const view = mountSolid(
    () => {
      const result = createComponent(ConfigPage, {
        get pageId() {
          return props().pageId ?? "advanced";
        },
        get routeData() {
          return props().routeData ?? null;
        },
      });
      return result;
    },
    { wrapper: provider.wrapper },
  );
  flush();
  return {
    container: view.container,
    get page() {
      return view.container.querySelector<HTMLElement>("openclaw-config-page")!;
    },
    setContext(next: ApplicationContext) {
      provider.setContext(completeConfigContext(next));
      flush();
    },
    update(next: Partial<typeof initial>) {
      setProps((previous) => ({ ...previous, ...next }));
      flush();
    },
    dispose: view.unmount,
  };
}

/** Mount the page's public presentation contract without rendering unrelated settings sections. */
export function mountConfigPageState(
  initialContext: ApplicationContext,
  initial: { pageId?: ConfigPageId; routeData?: ConfigRouteData | null } = {},
) {
  const context = completeConfigContext(initialContext);
  const [route, setRoute] = createSignal(initial);
  const host = document.createElement("openclaw-config-page");
  let state!: ReturnType<typeof createConfigPage>;
  const view = mountSolid(() => {
    state = createConfigPage(
      context,
      () => ({ pageId: route().pageId ?? "advanced", routeData: route().routeData ?? null }),
      () => host,
    );
    return host;
  });
  flush();
  return {
    state,
    update(next: Partial<typeof initial>) {
      setRoute((previous) => ({ ...previous, ...next }));
      flush();
    },
    dispose: view.unmount,
  };
}
