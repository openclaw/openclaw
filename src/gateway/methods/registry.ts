import type { PluginRegistry } from "../../plugins/registry-types.js";
import { normalizePluginGatewayMethodScope } from "../../shared/gateway-method-policy.js";
import { ADMIN_SCOPE, type OperatorScope } from "../operator-scopes.js";
import {
  createCoreGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
} from "./core-descriptors.js";
import {
  DYNAMIC_GATEWAY_METHOD_SCOPE,
  type GatewayMethodDescriptor,
  type GatewayMethodHandler,
  type GatewayMethodDescriptorInput,
  type GatewayMethodOwner,
  type GatewayMethodRegistryView,
  NODE_GATEWAY_METHOD_SCOPE,
} from "./descriptor.js";

export type GatewayMethodRegistry = GatewayMethodRegistryView;
export { createCoreGatewayMethodDescriptors, isCoreGatewayMethodClassified };

function normalizeMethodName(name: string): string {
  return name.trim();
}

function normalizeDescriptor(input: GatewayMethodDescriptorInput): GatewayMethodDescriptor {
  const name = normalizeMethodName(input.name);
  if (!name) {
    throw new Error("gateway method descriptor name must not be empty");
  }
  // Plugin-owned methods pass through the plugin namespace policy so plugins cannot weaken
  // protected core-looking method names by declaring a permissive scope.
  const normalizedScope =
    input.scope === NODE_GATEWAY_METHOD_SCOPE || input.scope === DYNAMIC_GATEWAY_METHOD_SCOPE
      ? input.scope
      : input.owner.kind === "plugin"
        ? normalizePluginGatewayMethodScope(name, input.scope).scope
        : input.scope;
  if (!normalizedScope) {
    throw new Error(`gateway method descriptor is missing a scope: ${name}`);
  }
  return {
    ...input,
    name,
    scope: normalizedScope,
    ...(input.startup === "unavailable-until-sidecars"
      ? { startup: "unavailable-until-sidecars" }
      : {}),
    ...(input.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
    ...(input.advertise === false ? { advertise: false } : {}),
  };
}

/**
 * Create a read-only registry for gateway method lookup, listing, and policy
 * metadata. Names are normalized once up front and duplicates are rejected so
 * dispatch, advertisement, and authorization all see the same descriptor.
 */
export function createGatewayMethodRegistry(
  inputs: readonly GatewayMethodDescriptorInput[],
): GatewayMethodRegistry {
  const descriptors = inputs.map(normalizeDescriptor);
  const byName = new Map<string, GatewayMethodDescriptor>();
  for (const descriptor of descriptors) {
    // Duplicate method names would make authorization and handler dispatch disagree about the
    // owner/scope, so reject them before exposing any registry view.
    if (byName.has(descriptor.name)) {
      throw new Error(`gateway method already registered: ${descriptor.name}`);
    }
    byName.set(descriptor.name, descriptor);
  }
  return {
    getHandler: (name) => byName.get(name)?.handler,
    listMethods: () => descriptors.map((descriptor) => descriptor.name),
    listAdvertisedMethods: () =>
      descriptors
        .filter((descriptor) => descriptor.advertise !== false)
        .map((descriptor) => descriptor.name),
    getScope: (name) => byName.get(name)?.scope,
    isStartupUnavailable: (name) => byName.get(name)?.startup === "unavailable-until-sidecars",
    isControlPlaneWrite: (name) => byName.get(name)?.controlPlaneWrite === true,
    descriptors: () => descriptors,
  };
}

/**
 * Convert a plain handler map into scoped descriptors owned by one gateway
 * surface. Every handler must receive either a per-method or default scope so
 * helper-created methods cannot bypass authorization metadata.
 */
export function createGatewayMethodDescriptorsFromHandlers(params: {
  /** Handler map keyed by raw gateway method name. */
  handlers: Record<string, GatewayMethodHandler>;
  /** Shared owner metadata attached to every generated descriptor. */
  owner: GatewayMethodOwner;
  /** Fallback scope used when `scopes` has no method-specific entry. */
  defaultScope?: OperatorScope;
  /** Per-method scope overrides for methods that need narrower or broader auth. */
  scopes?: Partial<Record<string, OperatorScope>>;
}): GatewayMethodDescriptorInput[] {
  return Object.entries(params.handlers).map(([name, handler]) => {
    const scope = params.scopes?.[name] ?? params.defaultScope;
    if (!scope) {
      throw new Error(`gateway method is missing a scope: ${name}`);
    }
    const descriptor: GatewayMethodDescriptorInput = {
      name,
      handler,
      owner: params.owner,
      scope,
    };
    return descriptor;
  });
}

/**
 * Create a plugin-owned method descriptor with plugin namespace scope
 * normalization. Protected gateway namespaces may upgrade the requested scope
 * before the descriptor reaches the registry.
 */
export function createPluginGatewayMethodDescriptor(params: {
  /** Owning plugin id attached to the descriptor owner metadata. */
  pluginId: string;
  /** Raw gateway method name before descriptor normalization. */
  name: string;
  /** Handler invoked when this plugin method is dispatched. */
  handler: GatewayMethodHandler;
  /** Requested operator scope; protected method namespaces may be upgraded. */
  scope?: OperatorScope;
}): GatewayMethodDescriptorInput {
  const normalizedScope = normalizePluginGatewayMethodScope(params.name, params.scope).scope;
  return {
    name: params.name,
    handler: params.handler,
    owner: { kind: "plugin", pluginId: params.pluginId },
    scope: normalizedScope ?? ADMIN_SCOPE,
  };
}

/**
 * Resolve plugin method descriptors, including the legacy handler-only registry
 * shape. Handler-only plugins default to admin scope until they can provide
 * explicit descriptor metadata.
 */
export function createPluginGatewayMethodDescriptors(
  registry: Pick<PluginRegistry, "gatewayHandlers"> &
    Partial<Pick<PluginRegistry, "gatewayMethodDescriptors">>,
): GatewayMethodDescriptorInput[] {
  const descriptors = registry.gatewayMethodDescriptors ?? [];
  if (descriptors.length > 0) {
    return [...descriptors];
  }
  // Older plugin registries only carried handlers, so keep them callable but assign admin scope
  // until the plugin can provide explicit descriptor metadata.
  return createGatewayMethodDescriptorsFromHandlers({
    handlers: registry.gatewayHandlers,
    owner: { kind: "plugin", pluginId: "unknown" },
    defaultScope: ADMIN_SCOPE,
  });
}
