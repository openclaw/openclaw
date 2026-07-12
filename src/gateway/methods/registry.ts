// Gateway method registry normalizes method descriptors, enforces unique names, and exposes dispatch policy metadata.
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { normalizePluginGatewayMethodScope } from "../../shared/gateway-method-policy.js";
import type {
  GatewayMethodAccessPolicy,
  GatewayResourceRef,
  GatewayResourceResolutionInput,
} from "../authorization/contracts.js";
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

function canonicalizePluginAccessPolicy(params: {
  pluginId: string;
  method: string;
  access: GatewayMethodAccessPolicy;
}): GatewayMethodAccessPolicy {
  const kind: unknown = params.access.kind;
  const permission: unknown =
    kind === "resource" ? (params.access as { permission?: unknown }).permission : undefined;
  const resolver: unknown =
    kind === "resource"
      ? (params.access as { resolveResources?: unknown }).resolveResources
      : undefined;
  const member: unknown =
    kind === "resource" ? (params.access as { member?: unknown }).member : undefined;
  if (kind !== "resource") {
    throw new Error(`plugin gateway method access must be resource-scoped: ${params.method}`);
  }
  if (typeof permission !== "string" || !permission.trim()) {
    throw new Error(`gateway method access permission must not be empty: ${params.method}`);
  }
  if (typeof resolver !== "function") {
    throw new Error(`plugin gateway method access resolver must be a function: ${params.method}`);
  }
  const resolveResources = resolver as (
    input: GatewayResourceResolutionInput,
  ) => Promise<readonly GatewayResourceRef[]> | readonly GatewayResourceRef[];
  return Object.freeze({
    kind: "resource" as const,
    ...(member === true ? { member: true } : {}),
    permission: permission.trim(),
    resolveResources: async (input: GatewayResourceResolutionInput) => {
      const resources = await resolveResources(input);
      if (!Array.isArray(resources)) {
        throw new Error("plugin gateway resource resolver must return an array");
      }
      return Object.freeze(
        resources.map((resource) => {
          if (!resource || resource.namespace !== params.pluginId) {
            throw new Error("plugin gateway resources must use the loader-bound plugin namespace");
          }
          return Object.freeze({
            namespace: params.pluginId,
            type: resource.type,
            id: resource.id,
          });
        }),
      );
    },
  });
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
  const access =
    input.access && input.owner.kind === "plugin"
      ? canonicalizePluginAccessPolicy({
          pluginId: input.owner.pluginId,
          method: name,
          access: input.access,
        })
      : input.access;
  if (access?.kind === "resource" && !access.permission.trim()) {
    throw new Error(`gateway method access permission must not be empty: ${name}`);
  }
  return {
    ...input,
    name,
    scope: normalizedScope,
    ...(access ? { access } : {}),
    ...(input.startup === "unavailable-until-sidecars"
      ? { startup: "unavailable-until-sidecars" }
      : {}),
    ...(input.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
    ...(input.advertise === false ? { advertise: false } : {}),
  };
}

/** Creates a read-only registry for gateway method lookup, listing, and policy metadata. */
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
    getOwner: (name) => byName.get(name)?.owner,
    getAccessPolicy: (name) => byName.get(name)?.access,
    isStartupUnavailable: (name) => byName.get(name)?.startup === "unavailable-until-sidecars",
    isControlPlaneWrite: (name) => byName.get(name)?.controlPlaneWrite === true,
    descriptors: () => descriptors,
  };
}

/** Converts a plain handler map into scoped descriptors owned by one gateway surface. */
export function createGatewayMethodDescriptorsFromHandlers(params: {
  handlers: Record<string, GatewayMethodHandler>;
  owner: GatewayMethodOwner;
  defaultScope?: OperatorScope;
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

/** Creates a plugin-owned method descriptor with plugin namespace scope normalization. */
export function createPluginGatewayMethodDescriptor(params: {
  pluginId: string;
  name: string;
  handler: GatewayMethodHandler;
  scope?: OperatorScope;
  access?: GatewayMethodAccessPolicy;
}): GatewayMethodDescriptorInput {
  const access = params.access
    ? canonicalizePluginAccessPolicy({
        pluginId: params.pluginId,
        method: params.name,
        access: params.access,
      })
    : undefined;
  const normalizedScope = normalizePluginGatewayMethodScope(params.name, params.scope).scope;
  return {
    name: params.name,
    handler: params.handler,
    owner: { kind: "plugin", pluginId: params.pluginId },
    scope: normalizedScope ?? ADMIN_SCOPE,
    ...(access ? { access } : {}),
  };
}

/** Resolves plugin method descriptors, including the legacy handler-only registry shape. */
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
