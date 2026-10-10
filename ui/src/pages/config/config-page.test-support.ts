import { render as mountSolid } from "@solidjs/web";
import { createComponent, createSignal, flush } from "solid-js";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { ConfigPage, type ConfigPageId } from "./config-page.tsx";
import type { ConfigRouteData } from "./route-data.ts";

const mounted = new Set<() => void>();
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
      serverSelection: null,
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
  ]) {
    observeFixture(source);
  }
  Object.assign(context.agentIdentity, { get: context.agentIdentity.get ?? (() => null) });
  Object.assign(context.config, {
    current: context.config.current ?? { assistantIdentity: { name: "OpenClaw" } },
  });
  Object.assign(context.overlays, { snapshot: context.overlays.snapshot ?? {} });
  Object.assign(context.webPush, { snapshot: context.webPush.snapshot ?? {} });
  Object.assign(context.theme, {
    branding: context.theme.branding ?? resolveThemeBranding(undefined),
    serverSelection: context.theme.serverSelection ?? null,
  });
  Object.assign(context.gateway, {
    connection: context.gateway.connection ?? { gatewayUrl: "ws://config.test" },
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
  const container = document.createElement("div");
  document.body.append(container);
  const [context, setContext] = createSignal(completeConfigContext(initialContext));
  const [props, setProps] = createSignal(initial);
  const stop = mountSolid(
    () =>
      createComponent(ApplicationProvider, {
        get value() {
          return context();
        },
        get children() {
          return createComponent(ConfigPage, {
            get pageId() {
              return props().pageId ?? "advanced";
            },
            get routeData() {
              return props().routeData ?? null;
            },
          });
        },
      }),
    container,
  );
  const dispose = () => {
    mounted.delete(dispose);
    stop();
    container.remove();
  };
  mounted.add(dispose);
  flush();
  return {
    container,
    get page() {
      return container.querySelector<HTMLElement>("openclaw-config-page")!;
    },
    setContext(next: ApplicationContext) {
      setContext(completeConfigContext(next));
      flush();
    },
    update(next: Partial<typeof initial>) {
      setProps((previous) => ({ ...previous, ...next }));
      flush();
    },
    dispose,
  };
}

export function cleanupConfigPages() {
  for (const dispose of mounted) {
    dispose();
  }
}

export async function settleConfigPage() {
  // Flush owners, Promise completions, and the resulting Solid commit separately.
  flush();
  await Promise.resolve();
  flush();
  await Promise.resolve();
  flush();
}
