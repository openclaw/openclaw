import type { PluginRegistry } from "../../plugins/registry-types.js";
import { normalizePluginGatewayMethodScope } from "../../shared/gateway-method-policy.js";
import type { OperatorScope } from "../operator-scopes.js";
import {
  DYNAMIC_GATEWAY_METHOD_SCOPE,
  type GatewayMethodDescriptor,
  type GatewayMethodHandler,
  type GatewayMethodDescriptorInput,
  type GatewayMethodOwner,
  type GatewayMethodRegistryView,
  NODE_GATEWAY_METHOD_SCOPE,
} from "./descriptor.js";
export {
  createCoreGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
} from "./core-method-policy.js";

export type GatewayMethodRegistry = GatewayMethodRegistryView;

function normalizeDescriptor(input: GatewayMethodDescriptorInput): GatewayMethodDescriptor {
  const name = input.name.trim();
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
  const profileAccess =
    input.profileAccess ??
    (input.sessionAccess || input.owner.kind !== "core" ? "required" : "independent");
  if (
    input.sessionAccess &&
    (normalizedScope !== "operator.write" || profileAccess === "independent")
  ) {
    throw new Error(
      `session-scoped gateway methods require operator.write and an authenticated profile: ${name}`,
    );
  }
  if (
    input.shareKey &&
    (input.sessionAccess ||
      input.controlPlaneWrite ||
      input.lifetime === "observation" ||
      (input.shareMaxAgeMs !== undefined &&
        (!Number.isFinite(input.shareMaxAgeMs) || input.shareMaxAgeMs <= 0)))
  ) {
    throw new Error(`gateway response sharing requires a bounded read-only method: ${name}`);
  }
  return {
    ...input,
    name,
    scope: normalizedScope,
    profileAccess,
    ...(input.startup === "unavailable-until-sidecars"
      ? { startup: "unavailable-until-sidecars" }
      : {}),
    ...(input.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
    ...(input.lifetime === "observation" ? { lifetime: "observation" } : {}),
    ...(input.advertise === false ? { advertise: false } : {}),
  };
}

export function createGatewayMethodRegistry(
  inputs: readonly GatewayMethodDescriptorInput[],
  pluginRegistry?: PluginRegistry,
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
    ...(pluginRegistry ? { pluginRegistry } : {}),
    getHandler: (name) => byName.get(name)?.handler,
    listMethods: () => descriptors.map((descriptor) => descriptor.name),
    listAdvertisedMethods: () =>
      descriptors
        .filter((descriptor) => descriptor.advertise !== false)
        .map((descriptor) => descriptor.name),
    getScope: (name) => byName.get(name)?.scope,
    getSessionAccess: (name) => byName.get(name)?.sessionAccess,
    getReadSharing: (name) => {
      const descriptor = byName.get(name);
      return descriptor?.shareKey
        ? {
            shareKey: descriptor.shareKey,
            shareInvalidationEvents: descriptor.shareInvalidationEvents ?? [],
            shareMaxAgeMs: descriptor.shareMaxAgeMs ?? 1_000,
          }
        : undefined;
    },
    isStartupUnavailable: (name) => byName.get(name)?.startup === "unavailable-until-sidecars",
    isObservation: (name) => byName.get(name)?.lifetime === "observation",
    isControlPlaneWrite: (name) => byName.get(name)?.controlPlaneWrite === true,
    requiresAuthenticatedProfile: (name) => byName.get(name)?.profileAccess === "required",
    descriptors: () => descriptors,
  };
}

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
    return {
      name,
      handler,
      owner: params.owner,
      scope,
    };
  });
}
