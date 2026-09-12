// Gateway request scope tracks request-local plugin runtime context across async work.
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginOrigin } from "../plugin-origin.types.js";
import type { DeclaredProviderOwnerIndex } from "../provider-owner-index.js";
import type { PluginRegistry } from "../registry-types.js";
import { getPluginRegistryState } from "../runtime-state.js";
import type { OpenClawPluginNodeWorkspace } from "../types.node-host.js";
import { getPluginRuntimeLoadContextState } from "./load-context-state.js";

type PluginRuntimeGatewayRequestScope = {
  /** Recheck the admitted HTTP device grant before effects; rejection sends HTTP 401 and throws. */
  revalidate?: () => Promise<void>;
  /** Exact placement owner captured before the local harness begins. */
  assertNodeExecutionCurrent?: (request: {
    runId: string;
    agentId: string;
    nodeId: string;
    workspace: OpenClawPluginNodeWorkspace;
  }) => void;
  /** In-process admitted owner only; never projected into RPC parameters. */
  invokeWithSessionNodeAuthority?: <T>(
    request: {
      pluginId: string;
      command: string;
      source: "session-full" | "human-approved";
      nodeId: string;
      workspace: OpenClawPluginNodeWorkspace;
    },
    invoke: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T | undefined>;
  /** Closure-bound admitted owner used to validate placement grant bindings. */
  nodePlacementGrantAuthority?: {
    agentId: string;
    sessionKey: string;
    runId: string;
    assertCurrent: (request: {
      pluginId: string;
      command: string;
      nodeId: string;
      workspace: OpenClawPluginNodeWorkspace;
    }) => void;
  };
  context?: GatewayRequestContext;
  resolveGatewayContext?: GatewayContextResolver;
  client?: GatewayRequestOptions["client"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  pluginId?: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  gatewayMethodDispatchAllowed?: boolean;
  pluginRegistry?: PluginRegistry;
  declaredProviderOwners?: DeclaredProviderOwnerIndex;
};

type PluginRuntimePluginScope = {
  pluginId: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
};

const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGatewayRequestScope",
);
const GATEWAY_CONTEXT_RESOLVERS_KEY: unique symbol = Symbol.for("openclaw.gatewayContextResolvers");

const pluginRuntimeGatewayRequestScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRuntimeGatewayRequestScope>
>(
  PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY,
  () => new AsyncLocalStorage<PluginRuntimeGatewayRequestScope>(),
);
// Built plugin chunks and source Gateway code must redeem the same host-issued owner bindings.
const gatewayContextResolvers = resolveGlobalSingleton<WeakMap<object, GatewayContextResolver>>(
  GATEWAY_CONTEXT_RESOLVERS_KEY,
  () => new WeakMap(),
);

// A closed resolver stays closed even if a late scoped loader borrows it again.
const gatewayContextLifetimes = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayContextLifetimes"),
  () => new WeakMap<GatewayContextResolver, AbortController>(),
);

export function getGatewayContextLifetime(resolver: GatewayContextResolver): AbortController {
  let lifetime = gatewayContextLifetimes.get(resolver);
  if (!lifetime) {
    lifetime = new AbortController();
    gatewayContextLifetimes.set(resolver, lifetime);
  }
  return lifetime;
}

export function bindGatewayContextResolver(
  owner: object,
  resolver: GatewayContextResolver | undefined,
): void {
  if (resolver) {
    gatewayContextResolvers.set(owner, resolver);
  }
}

export const getGatewayContextResolver = (owner: object) => gatewayContextResolvers.get(owner);

/** Follows explicit wrapper ownership without invoking any execution resolver. */
export function getCanonicalGatewayContextResolver(
  resolver: GatewayContextResolver,
): GatewayContextResolver | undefined {
  const seen = new Set<GatewayContextResolver>();
  let current = resolver;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = gatewayContextResolvers.get(current);
    if (!parent) {
      return current;
    }
    current = parent;
  }
  return undefined;
}

/** Match the host owner without invoking a possibly retired execution resolver. */
export function hasGatewayContextOwner(
  owner: object,
  gatewayOwner: GatewayContextResolver,
): boolean {
  const resolver = gatewayContextResolvers.get(owner);
  // A lifetime wrapper records one canonical host owner; it remains the execution binding.
  return (
    resolver !== undefined && (gatewayContextResolvers.get(resolver) ?? resolver) === gatewayOwner
  );
}

export const clearGatewayContextResolver = (owner: object) => gatewayContextResolvers.delete(owner);

/** Carry only closure-bound node authorities into a nested request scope. */
export function getPluginRuntimeGatewayNodeAuthorities() {
  const scope = pluginRuntimeGatewayRequestScope.getStore();
  return {
    invokeWithSessionNodeAuthority: scope?.invokeWithSessionNodeAuthority,
    nodePlacementGrantAuthority: scope?.nodePlacementGrantAuthority,
  };
}

export function getSharedGatewayContextResolver(
  owners: readonly object[],
): GatewayContextResolver | undefined {
  const resolvers = owners.map(getGatewayContextResolver);
  if (resolvers.every((resolve) => !resolve)) {
    return undefined;
  }
  // Separate caller wrappers may own one instance. Recheck every captured fence;
  // never replace it with a current global resolver or permit mixed ambient routing.
  const shared = () => {
    const contexts = resolvers.map((resolve) => {
      try {
        return resolve?.();
      } catch {
        return undefined;
      }
    });
    if (resolvers.some((resolve) => !resolve)) {
      throw new Error("incompatible Gateway bindings: bound and unbound owners");
    }
    if (contexts.some((context) => !context)) {
      return undefined;
    }
    if (contexts.some((context) => context !== contexts[0])) {
      throw new Error("incompatible Gateway instances");
    }
    return contexts[0];
  };
  const canonical = resolvers.map((resolve) =>
    resolve ? getCanonicalGatewayContextResolver(resolve) : undefined,
  );
  const owner = canonical[0];
  if (owner && canonical.every((candidate) => candidate === owner)) {
    bindGatewayContextResolver(shared, owner);
  }
  return shared;
}

/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
): T {
  return pluginRuntimeGatewayRequestScope.run(scope, run);
}

/** Runs detached work with its captured Gateway binding, including an explicitly unbound owner. */
export function withPluginRuntimeGatewayContextResolver<T>(
  resolveGatewayContext: GatewayContextResolver | undefined,
  run: () => T,
  options?: { inheritRequestScope?: boolean },
): T {
  // Scheduler-owned work must not retain the request-local client or context
  // that happened to exist when its timer was armed.
  const current =
    options?.inheritRequestScope === false
      ? undefined
      : pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = {
    ...current,
    isWebchatConnect: current?.isWebchatConnect ?? (() => false),
    resolveGatewayContext,
  };
  delete scoped.context;
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/** Runs work against an owned registry handle while preserving any gateway request facts. */
export function withPluginRuntimeRegistryScope<T>(
  registry: PluginRegistry | undefined,
  run: () => T,
  declaredProviderOwners?: DeclaredProviderOwnerIndex,
): T {
  if (!registry) {
    return run();
  }
  const current = pluginRuntimeGatewayRequestScope.getStore();
  return pluginRuntimeGatewayRequestScope.run(
    createRegistryScope(registry, current, declaredProviderOwners),
    run,
  );
}

function createRegistryScope(
  registry: PluginRegistry,
  current: PluginRuntimeGatewayRequestScope | undefined,
  declaredProviderOwners?: DeclaredProviderOwnerIndex,
): PluginRuntimeGatewayRequestScope {
  return {
    isWebchatConnect: () => false,
    ...current,
    pluginRegistry: registry,
    declaredProviderOwners:
      declaredProviderOwners ??
      // Nested calls keep this prepared registry's facts, never a different registry's index.
      (current?.pluginRegistry === registry ? current.declaredProviderOwners : undefined) ??
      getPluginRuntimeLoadContextState(registry)?.declaredProviderOwners,
  };
}

function applyPluginScope(
  scoped: PluginRuntimeGatewayRequestScope,
  scope: PluginRuntimePluginScope,
): void {
  scoped.pluginId = scope.pluginId;
  if (scope.pluginSource !== undefined) {
    scoped.pluginSource = scope.pluginSource;
  } else {
    delete scoped.pluginSource;
  }
  if (scope.pluginOrigin !== undefined) {
    scoped.pluginOrigin = scope.pluginOrigin;
  } else {
    delete scoped.pluginOrigin;
  }
  if (scope.pluginTrustedOfficialInstall !== undefined) {
    scoped.pluginTrustedOfficialInstall = scope.pluginTrustedOfficialInstall;
  } else {
    delete scoped.pluginTrustedOfficialInstall;
  }
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginScope<T>(
  scope: PluginRuntimePluginScope,
  run: () => T,
  registry?: PluginRegistry,
): T {
  const current = pluginRuntimeGatewayRequestScope.getStore();
  // Instance calls combine registry and identity without adding a second async frame.
  const scoped: PluginRuntimeGatewayRequestScope = registry
    ? createRegistryScope(registry, current)
    : current
      ? { ...current }
      : { isWebchatConnect: () => false };
  applyPluginScope(scoped, scope);
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/** Drops only generation selection; authenticated Gateway caller and authority stay attached. */
export function runOutsidePluginRuntimeRegistryScope<T>(run: () => T): T {
  const current = pluginRuntimeGatewayRequestScope.getStore();
  if (!current) {
    return run();
  }
  // Registry selection and its declared provider index belong to the same generation.
  return pluginRuntimeGatewayRequestScope.run(
    { ...current, pluginRegistry: undefined, declaredProviderOwners: undefined },
    run,
  );
}

/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export function getPluginRuntimeGatewayRequestScope():
  | PluginRuntimeGatewayRequestScope
  | undefined {
  return pluginRuntimeGatewayRequestScope.getStore();
}

/** Reads registration/request/active registry precedence without initializing a cold runtime. */
export function getPluginRegistryForContext(): PluginRegistry | null {
  const state = getPluginRegistryState();
  return (
    state?.registrationContext?.registry ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    state?.activeRegistry ??
    null
  );
}
