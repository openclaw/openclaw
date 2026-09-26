// Gateway request scope tracks request-local plugin runtime context across async work.
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../../gateway/server-methods/types.js";
import {
  getPluginExecutionFrame,
  pluginInstanceInvocation,
  runWithPluginExecutionFrame,
} from "../plugin-instance-invocation.js";
import type { PluginInstanceInvocation } from "../plugin-instance-invocation.types.js";
import type { PluginOrigin } from "../plugin-origin.types.js";
import type { DeclaredProviderOwnerIndex } from "../provider-owner-index.js";
import type { PluginRegistry } from "../registry-types.js";
import { getPluginRegistryState } from "../runtime-state.js";
import { getPluginRuntimeExecutionFrame, PluginRuntimeExecutionFrame } from "./execution-frame.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.types.js";
import { getPluginRuntimeLoadContextState } from "./load-context-state.js";

export {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
  getGatewayContextResolver,
  getSharedGatewayContextResolver,
  hasGatewayContextOwner,
} from "./gateway-context-binding.js";

type PluginRuntimePluginScope = {
  pluginId: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
};

function getPluginGatewayScope(): PluginRuntimeGatewayRequestScope | undefined {
  return getPluginRuntimeExecutionFrame()?.gatewayScope;
}

function runWithPluginGatewayScope<T>(
  gatewayScope: PluginRuntimeGatewayRequestScope,
  run: () => T,
  invocation = pluginInstanceInvocation.getStore(),
): T {
  const current = getPluginExecutionFrame();
  const runtime = getPluginRuntimeExecutionFrame(current);
  return runWithPluginExecutionFrame(
    runtime?.gatewayScope === gatewayScope && runtime.invocation === invocation
      ? runtime
      : new PluginRuntimeExecutionFrame(
          { ...current, invocation },
          gatewayScope,
          runtime?.generationRegistry,
        ),
    run,
  );
}

const isNotWebchatConnect = () => false;

/** Carry only closure-bound node authorities into a nested request scope. */
export function getPluginRuntimeGatewayNodeAuthorities() {
  const scope = getPluginGatewayScope();
  return {
    invokeWithSessionNodeAuthority: scope?.invokeWithSessionNodeAuthority,
    nodePlacementGrantAuthority: scope?.nodePlacementGrantAuthority,
  };
}

/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
): T {
  return runWithPluginGatewayScope(scope, run);
}

/** Runs detached work with its captured Gateway binding, including an explicitly unbound owner. */
export function withPluginRuntimeGatewayContextResolver<T>(
  resolveGatewayContext: GatewayContextResolver | undefined,
  run: () => T,
  options?: { inheritRequestScope?: boolean },
): T {
  // Scheduler-owned work must not retain the request-local client or context
  // that happened to exist when its timer was armed.
  const current = options?.inheritRequestScope === false ? undefined : getPluginGatewayScope();
  const scoped: PluginRuntimeGatewayRequestScope = {
    ...current,
    isWebchatConnect: current?.isWebchatConnect ?? isNotWebchatConnect,
    resolveGatewayContext,
  };
  delete scoped.context;
  return runWithPluginGatewayScope(scoped, run);
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
  const current = getPluginGatewayScope();
  return runWithPluginGatewayScope(
    createRegistryScope(registry, current, declaredProviderOwners),
    run,
  );
}

export function createRegistryScope(
  registry: PluginRegistry,
  current: PluginRuntimeGatewayRequestScope | undefined,
  declaredProviderOwners?: DeclaredProviderOwnerIndex,
): PluginRuntimeGatewayRequestScope {
  return {
    isWebchatConnect: isNotWebchatConnect,
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
  invocation?: PluginInstanceInvocation,
): T {
  const current = getPluginGatewayScope();
  // Instance calls combine registry and identity without adding a second async frame.
  const scoped: PluginRuntimeGatewayRequestScope = registry
    ? createRegistryScope(registry, current)
    : current
      ? { ...current }
      : { isWebchatConnect: isNotWebchatConnect };
  applyPluginScope(scoped, scope);
  return runWithPluginGatewayScope(scoped, run, invocation);
}

/** Drops only generation selection; authenticated Gateway caller and authority stay attached. */
export function runOutsidePluginRuntimeRegistryScope<T>(run: () => T): T {
  const current = getPluginGatewayScope();
  if (!current) {
    return run();
  }
  // Registry selection and its declared provider index belong to the same generation.
  return runWithPluginGatewayScope(
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
  return getPluginGatewayScope();
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

/** Live request context for trusted built-in tools that need direct runtime state. */
export function getInProcessGatewayRequestContext(
  resolveGatewayContext?: GatewayContextResolver,
): GatewayRequestContext | undefined {
  if (resolveGatewayContext) {
    return resolveGatewayContext();
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  return scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
}
