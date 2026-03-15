import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import type {
  PluginCliRegistration,
  PluginHttpRouteRegistration,
  PluginProviderRegistration,
  PluginRegistry,
  PluginServiceRegistration,
  PluginToolRegistration,
} from "../plugins/registry.js";

const EMPTY_PROVIDERS: readonly PluginProviderRegistration[] = [];
const EMPTY_TOOLS: readonly PluginToolRegistration[] = [];
const EMPTY_SERVICES: readonly PluginServiceRegistration[] = [];
const EMPTY_CLI_REGISTRARS: readonly PluginCliRegistration[] = [];
const EMPTY_HTTP_ROUTES: readonly PluginHttpRouteRegistration[] = [];
const EMPTY_GATEWAY_HANDLERS: Readonly<GatewayRequestHandlers> = Object.freeze({});
const EXTENSION_HOST_RUNTIME_REGISTRY_STATE = Symbol.for("openclaw.extensionHostRuntimeRegistry");

type ExtensionHostRuntimeRegistryState = {
  tools: PluginToolRegistration[];
  legacyTools: PluginToolRegistration[];
  providers: PluginProviderRegistration[];
  legacyProviders: PluginProviderRegistration[];
  cliRegistrars: PluginCliRegistration[];
  legacyCliRegistrars: PluginCliRegistration[];
  services: PluginServiceRegistration[];
  legacyServices: PluginServiceRegistration[];
  httpRoutes: PluginHttpRouteRegistration[];
  legacyHttpRoutes: PluginHttpRouteRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  legacyGatewayHandlers: GatewayRequestHandlers;
};

type RuntimeRegistryBackedPluginRegistry = Pick<
  PluginRegistry,
  "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
> & {
  [EXTENSION_HOST_RUNTIME_REGISTRY_STATE]?: ExtensionHostRuntimeRegistryState;
};

function ensureExtensionHostRuntimeRegistryState(
  registry: RuntimeRegistryBackedPluginRegistry,
): ExtensionHostRuntimeRegistryState {
  if (registry[EXTENSION_HOST_RUNTIME_REGISTRY_STATE]) {
    return registry[EXTENSION_HOST_RUNTIME_REGISTRY_STATE];
  }

  const legacyHttpRoutes = registry.httpRoutes ?? [];
  registry.httpRoutes = legacyHttpRoutes;
  const legacyGatewayHandlers = registry.gatewayHandlers ?? {};
  registry.gatewayHandlers = legacyGatewayHandlers;
  const legacyCliRegistrars = registry.cliRegistrars ?? [];
  registry.cliRegistrars = legacyCliRegistrars;
  const legacyServices = registry.services ?? [];
  registry.services = legacyServices;
  const legacyTools = registry.tools ?? [];
  registry.tools = legacyTools;
  const legacyProviders = registry.providers ?? [];
  registry.providers = legacyProviders;

  const state: ExtensionHostRuntimeRegistryState = {
    tools: [...legacyTools],
    legacyTools,
    providers: [...legacyProviders],
    legacyProviders,
    cliRegistrars: [...legacyCliRegistrars],
    legacyCliRegistrars,
    services: [...legacyServices],
    legacyServices,
    httpRoutes: [...legacyHttpRoutes],
    legacyHttpRoutes,
    gatewayHandlers: { ...legacyGatewayHandlers },
    legacyGatewayHandlers,
  };
  registry[EXTENSION_HOST_RUNTIME_REGISTRY_STATE] = state;
  return state;
}

function syncLegacyTools(state: ExtensionHostRuntimeRegistryState): void {
  state.legacyTools.splice(0, state.legacyTools.length, ...state.tools);
}

function syncLegacyProviders(state: ExtensionHostRuntimeRegistryState): void {
  state.legacyProviders.splice(0, state.legacyProviders.length, ...state.providers);
}

function syncLegacyCliRegistrars(state: ExtensionHostRuntimeRegistryState): void {
  state.legacyCliRegistrars.splice(0, state.legacyCliRegistrars.length, ...state.cliRegistrars);
}

function syncLegacyServices(state: ExtensionHostRuntimeRegistryState): void {
  state.legacyServices.splice(0, state.legacyServices.length, ...state.services);
}

function syncLegacyHttpRoutes(state: ExtensionHostRuntimeRegistryState): void {
  state.legacyHttpRoutes.splice(0, state.legacyHttpRoutes.length, ...state.httpRoutes);
}

function syncLegacyGatewayHandlers(state: ExtensionHostRuntimeRegistryState): void {
  for (const key of Object.keys(state.legacyGatewayHandlers)) {
    if (!(key in state.gatewayHandlers)) {
      delete state.legacyGatewayHandlers[key];
    }
  }
  Object.assign(state.legacyGatewayHandlers, state.gatewayHandlers);
}

export function hasExtensionHostRuntimeEntries(
  registry:
    | Pick<
        PluginRegistry,
        | "plugins"
        | "channels"
        | "tools"
        | "providers"
        | "gatewayHandlers"
        | "httpRoutes"
        | "cliRegistrars"
        | "services"
        | "commands"
        | "hooks"
        | "typedHooks"
      >
    | null
    | undefined,
): boolean {
  if (!registry) {
    return false;
  }
  return (
    registry.plugins.length > 0 ||
    registry.channels.length > 0 ||
    listExtensionHostToolRegistrations(registry).length > 0 ||
    listExtensionHostProviderRegistrations(registry).length > 0 ||
    Object.keys(getExtensionHostGatewayHandlers(registry)).length > 0 ||
    listExtensionHostHttpRoutes(registry).length > 0 ||
    listExtensionHostCliRegistrations(registry).length > 0 ||
    listExtensionHostServiceRegistrations(registry).length > 0 ||
    registry.commands.length > 0 ||
    registry.hooks.length > 0 ||
    registry.typedHooks.length > 0
  );
}

export function listExtensionHostProviderRegistrations(
  registry:
    | Pick<
        PluginRegistry,
        "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
      >
    | null
    | undefined,
): readonly PluginProviderRegistration[] {
  if (!registry) {
    return EMPTY_PROVIDERS;
  }
  return ensureExtensionHostRuntimeRegistryState(registry as RuntimeRegistryBackedPluginRegistry)
    .providers;
}

export function listExtensionHostToolRegistrations(
  registry:
    | Pick<
        PluginRegistry,
        "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
      >
    | null
    | undefined,
): readonly PluginToolRegistration[] {
  if (!registry) {
    return EMPTY_TOOLS;
  }
  return ensureExtensionHostRuntimeRegistryState(registry as RuntimeRegistryBackedPluginRegistry)
    .tools;
}

export function listExtensionHostServiceRegistrations(
  registry:
    | Pick<PluginRegistry, "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers">
    | null
    | undefined,
): readonly PluginServiceRegistration[] {
  if (!registry) {
    return EMPTY_SERVICES;
  }
  return ensureExtensionHostRuntimeRegistryState(registry as RuntimeRegistryBackedPluginRegistry)
    .services;
}

export function listExtensionHostCliRegistrations(
  registry:
    | Pick<PluginRegistry, "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers">
    | null
    | undefined,
): readonly PluginCliRegistration[] {
  if (!registry) {
    return EMPTY_CLI_REGISTRARS;
  }
  return ensureExtensionHostRuntimeRegistryState(registry as RuntimeRegistryBackedPluginRegistry)
    .cliRegistrars;
}

export function listExtensionHostHttpRoutes(
  registry:
    | Pick<
        PluginRegistry,
        "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
      >
    | null
    | undefined,
): readonly PluginHttpRouteRegistration[] {
  if (!registry) {
    return EMPTY_HTTP_ROUTES;
  }
  return ensureExtensionHostRuntimeRegistryState(registry as RuntimeRegistryBackedPluginRegistry)
    .httpRoutes;
}

export function getExtensionHostGatewayHandlers(
  registry:
    | Pick<
        PluginRegistry,
        "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
      >
    | null
    | undefined,
): Readonly<GatewayRequestHandlers> {
  if (!registry) {
    return EMPTY_GATEWAY_HANDLERS;
  }
  return ensureExtensionHostRuntimeRegistryState(registry as RuntimeRegistryBackedPluginRegistry)
    .gatewayHandlers;
}

export function addExtensionHostHttpRoute(
  registry: Pick<
    PluginRegistry,
    "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
  >,
  entry: PluginHttpRouteRegistration,
): void {
  const state = ensureExtensionHostRuntimeRegistryState(
    registry as RuntimeRegistryBackedPluginRegistry,
  );
  state.httpRoutes.push(entry);
  syncLegacyHttpRoutes(state);
}

export function replaceExtensionHostHttpRoute(params: {
  registry: Pick<
    PluginRegistry,
    "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
  >;
  index: number;
  entry: PluginHttpRouteRegistration;
}): void {
  const state = ensureExtensionHostRuntimeRegistryState(
    params.registry as RuntimeRegistryBackedPluginRegistry,
  );
  state.httpRoutes[params.index] = params.entry;
  syncLegacyHttpRoutes(state);
}

export function removeExtensionHostHttpRoute(
  registry: Pick<
    PluginRegistry,
    "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
  >,
  entry: PluginHttpRouteRegistration,
): void {
  const state = ensureExtensionHostRuntimeRegistryState(
    registry as RuntimeRegistryBackedPluginRegistry,
  );
  const index = state.httpRoutes.indexOf(entry);
  if (index < 0) {
    return;
  }
  state.httpRoutes.splice(index, 1);
  syncLegacyHttpRoutes(state);
}

export function setExtensionHostGatewayHandler(params: {
  registry: Pick<
    PluginRegistry,
    "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
  >;
  method: string;
  handler: GatewayRequestHandlers[string];
}): void {
  const state = ensureExtensionHostRuntimeRegistryState(
    params.registry as RuntimeRegistryBackedPluginRegistry,
  );
  state.gatewayHandlers[params.method] = params.handler;
  syncLegacyGatewayHandlers(state);
}

export function addExtensionHostCliRegistration(
  registry: Pick<
    PluginRegistry,
    "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
  >,
  entry: PluginCliRegistration,
): void {
  const state = ensureExtensionHostRuntimeRegistryState(
    registry as RuntimeRegistryBackedPluginRegistry,
  );
  state.cliRegistrars.push(entry);
  syncLegacyCliRegistrars(state);
}

export function addExtensionHostServiceRegistration(
  registry: Pick<
    PluginRegistry,
    "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
  >,
  entry: PluginServiceRegistration,
): void {
  const state = ensureExtensionHostRuntimeRegistryState(
    registry as RuntimeRegistryBackedPluginRegistry,
  );
  state.services.push(entry);
  syncLegacyServices(state);
}

export function addExtensionHostToolRegistration(
  registry: Pick<
    PluginRegistry,
    "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
  >,
  entry: PluginToolRegistration,
): void {
  const state = ensureExtensionHostRuntimeRegistryState(
    registry as RuntimeRegistryBackedPluginRegistry,
  );
  state.tools.push(entry);
  syncLegacyTools(state);
}

export function addExtensionHostProviderRegistration(
  registry: Pick<
    PluginRegistry,
    "tools" | "providers" | "cliRegistrars" | "services" | "httpRoutes" | "gatewayHandlers"
  >,
  entry: PluginProviderRegistration,
): void {
  const state = ensureExtensionHostRuntimeRegistryState(
    registry as RuntimeRegistryBackedPluginRegistry,
  );
  state.providers.push(entry);
  syncLegacyProviders(state);
}
