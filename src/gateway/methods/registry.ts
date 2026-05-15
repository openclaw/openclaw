import type { PluginRegistry } from "../../plugins/registry-types.js";
import { normalizePluginGatewayMethodScope } from "../../shared/gateway-method-policy.js";
import { ADMIN_SCOPE, type OperatorScope } from "../operator-scopes.js";
import {
  DYNAMIC_GATEWAY_METHOD_SCOPE,
  type GatewayMethodDescriptor,
  type GatewayMethodHandler,
  type GatewayMethodDescriptorInput,
  type GatewayMethodOwner,
  type GatewayMethodRegistryView,
  type GatewayMethodScope,
  NODE_GATEWAY_METHOD_SCOPE,
} from "./descriptor.js";
import {
  CONTROL_PLANE_WRITE_METHODS,
  CORE_ADVERTISED_GATEWAY_METHODS,
  DYNAMIC_OPERATOR_SCOPE_METHODS,
  METHOD_SCOPE_BY_NAME,
  NODE_ROLE_METHODS,
  STARTUP_UNAVAILABLE_GATEWAY_METHODS,
} from "./legacy-metadata.js";

export type GatewayMethodRegistry = GatewayMethodRegistryView;

function normalizeMethodName(name: string): string {
  return name.trim();
}

export function resolveLegacyGatewayMethodScope(method: string): GatewayMethodScope | undefined {
  if (NODE_ROLE_METHODS.has(method)) {
    return NODE_GATEWAY_METHOD_SCOPE;
  }
  if (DYNAMIC_OPERATOR_SCOPE_METHODS.has(method)) {
    return DYNAMIC_GATEWAY_METHOD_SCOPE;
  }
  return METHOD_SCOPE_BY_NAME.get(method);
}

function normalizeDescriptor(input: GatewayMethodDescriptorInput): GatewayMethodDescriptor {
  const name = normalizeMethodName(input.name);
  if (!name) {
    throw new Error("gateway method descriptor name must not be empty");
  }
  const normalizedScope =
    input.scope === NODE_GATEWAY_METHOD_SCOPE || input.scope === DYNAMIC_GATEWAY_METHOD_SCOPE
      ? input.scope
      : normalizePluginGatewayMethodScope(name, input.scope).scope;
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

export function createGatewayMethodRegistry(
  inputs: readonly GatewayMethodDescriptorInput[],
): GatewayMethodRegistry {
  const descriptors = inputs.map(normalizeDescriptor);
  const byName = new Map<string, GatewayMethodDescriptor>();
  for (const descriptor of descriptors) {
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

export function createGatewayMethodDescriptorsFromHandlers(params: {
  handlers: Record<string, GatewayMethodHandler>;
  owner: GatewayMethodOwner;
  defaultScope?: OperatorScope;
  scopes?: Partial<Record<string, OperatorScope>>;
  startupUnavailableMethods?: ReadonlySet<string>;
}): GatewayMethodDescriptorInput[] {
  return Object.entries(params.handlers).map(([name, handler]) => {
    const scope =
      params.scopes?.[name] ?? resolveLegacyGatewayMethodScope(name) ?? params.defaultScope;
    if (!scope) {
      throw new Error(`gateway method is missing a scope: ${name}`);
    }
    const descriptor: GatewayMethodDescriptorInput = {
      name,
      handler,
      owner: params.owner,
      scope,
    };
    if (params.startupUnavailableMethods?.has(name)) {
      descriptor.startup = "unavailable-until-sidecars";
    }
    if (CONTROL_PLANE_WRITE_METHODS.has(name)) {
      descriptor.controlPlaneWrite = true;
    }
    if (params.owner.kind === "core" && !CORE_ADVERTISED_GATEWAY_METHODS.has(name)) {
      descriptor.advertise = false;
    }
    return descriptor;
  });
}

export function createCoreGatewayMethodDescriptors(
  handlers: Record<string, GatewayMethodHandler>,
): GatewayMethodDescriptorInput[] {
  return createGatewayMethodDescriptorsFromHandlers({
    handlers,
    owner: { kind: "core", area: "gateway" },
    startupUnavailableMethods: new Set(STARTUP_UNAVAILABLE_GATEWAY_METHODS),
  });
}

export function createPluginGatewayMethodDescriptor(params: {
  pluginId: string;
  name: string;
  handler: GatewayMethodHandler;
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

export function createPluginGatewayMethodDescriptors(
  registry: Pick<PluginRegistry, "gatewayHandlers" | "gatewayMethodScopes"> &
    Partial<Pick<PluginRegistry, "gatewayMethodDescriptors">>,
): GatewayMethodDescriptorInput[] {
  const descriptors = registry.gatewayMethodDescriptors ?? [];
  if (descriptors.length > 0) {
    return [...descriptors];
  }
  return createGatewayMethodDescriptorsFromHandlers({
    handlers: registry.gatewayHandlers,
    owner: { kind: "plugin", pluginId: "unknown" },
    defaultScope: ADMIN_SCOPE,
    scopes: registry.gatewayMethodScopes,
  });
}
