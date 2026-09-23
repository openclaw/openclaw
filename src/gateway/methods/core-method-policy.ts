// Derives method lookup, authorization, startup, and dispatch policy from the canonical table.
import type { OperatorScope } from "../operator-scopes.js";
import { CORE_GATEWAY_METHOD_SPECS, type CoreGatewayMethodSpec } from "./core-descriptors.js";
import { isCoreGatewayMethodProfileDependent } from "./core-profile-access.js";
import {
  DYNAMIC_GATEWAY_METHOD_SCOPE,
  NODE_GATEWAY_METHOD_SCOPE,
  type GatewayMethodDescriptorInput,
  type GatewayMethodHandler,
} from "./descriptor.js";

type CoreGatewayMethodMetadata = Pick<CoreGatewayMethodSpec, "name" | "scope" | "since">;

export type CoreGatewayHandlerFamily = Exclude<(typeof CORE_GATEWAY_METHOD_SPECS)[number][1], null>;

// Rows are `as const`, so a present policy flag is already the exact literal the spec allows.
const CORE_GATEWAY_METHOD_SPEC_LIST: readonly CoreGatewayMethodSpec[] =
  CORE_GATEWAY_METHOD_SPECS.map(([name, family, scope, since, policy]) =>
    Object.assign({ name, scope, since, ...(family ? { family } : {}) }, policy),
  );

const CORE_GATEWAY_METHOD_SPEC_BY_NAME: ReadonlyMap<string, CoreGatewayMethodSpec> = new Map(
  CORE_GATEWAY_METHOD_SPEC_LIST.map((spec) => [spec.name, spec]),
);

/** Core methods that are listed early but return retryable unavailable until sidecars are ready. */
export const STARTUP_UNAVAILABLE_GATEWAY_METHODS = CORE_GATEWAY_METHOD_SPEC_LIST.filter(
  (spec) => spec.startup === true,
).map((spec) => spec.name);

/** Returns the core methods that should be advertised to external gateway clients. */
export function listCoreAdvertisedGatewayMethodNames(): string[] {
  return CORE_GATEWAY_METHOD_SPEC_LIST.filter((spec) => spec.advertise !== false).map(
    (spec) => spec.name,
  );
}

/** Returns all registered core method names, including hidden/internal compatibility methods. */
export function listCoreGatewayMethodNames(): string[] {
  return CORE_GATEWAY_METHOD_SPEC_LIST.map((spec) => spec.name);
}

/** Returns the public metadata emitted for every core gateway method. */
export function listCoreGatewayMethodMetadata(): readonly CoreGatewayMethodMetadata[] {
  return CORE_GATEWAY_METHOD_SPEC_LIST.map(({ name, scope, since }) => ({ name, scope, since }));
}

/** Groups lazy-owned core methods by the module family that dispatches them. */
export function listCoreGatewayHandlerMethodNames(): ReadonlyMap<
  CoreGatewayHandlerFamily,
  readonly string[]
> {
  const methodsByFamily = new Map<CoreGatewayHandlerFamily, string[]>();
  for (const [name, family] of CORE_GATEWAY_METHOD_SPECS) {
    if (family) {
      const methods = methodsByFamily.get(family) ?? [];
      methods.push(name);
      methodsByFamily.set(family, methods);
    }
  }
  return methodsByFamily;
}

/** Looks up an operator-only core method scope, excluding node and dynamic methods. */
export function resolveCoreOperatorGatewayMethodScope(method: string): OperatorScope | undefined {
  const scope = CORE_GATEWAY_METHOD_SPEC_BY_NAME.get(method)?.scope;
  return scope === NODE_GATEWAY_METHOD_SCOPE || scope === DYNAMIC_GATEWAY_METHOD_SCOPE
    ? undefined
    : scope;
}

/** Returns true for core methods reserved for authenticated node clients. */
export function isCoreNodeGatewayMethod(method: string): boolean {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.get(method)?.scope === NODE_GATEWAY_METHOD_SCOPE;
}

/** Returns true for core methods whose required operator scope is resolved by the handler. */
export function isDynamicOperatorGatewayMethod(method: string): boolean {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.get(method)?.scope === DYNAMIC_GATEWAY_METHOD_SCOPE;
}

/** Returns true when a method name has an explicit core policy entry. */
export function isCoreGatewayMethodClassified(method: string): boolean {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.has(method);
}

/** Creates dispatch descriptors for core handlers and fails if any handler lacks policy. */
export function createCoreGatewayMethodDescriptors(
  handlers: Record<string, GatewayMethodHandler>,
): GatewayMethodDescriptorInput[] {
  const descriptors: GatewayMethodDescriptorInput[] = [];
  for (const spec of CORE_GATEWAY_METHOD_SPEC_LIST) {
    const handler = handlers[spec.name];
    if (!handler) {
      continue;
    }
    descriptors.push({
      name: spec.name,
      handler,
      owner: { kind: "core", area: "gateway" },
      scope: spec.scope,
      profileAccess: isCoreGatewayMethodProfileDependent(spec.name) ? "required" : "independent",
      ...(spec.since ? { since: spec.since } : {}),
      ...(spec.advertise === false ? { advertise: false } : {}),
      ...(spec.startup === true ? { startup: "unavailable-until-sidecars" } : {}),
      ...(spec.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
      ...(spec.description ? { description: spec.description } : {}),
    });
  }
  for (const name of Object.keys(handlers)) {
    if (!CORE_GATEWAY_METHOD_SPEC_BY_NAME.has(name)) {
      // Unclassified core handlers would bypass scope/startup/write metadata, so fail before the
      // dispatcher can expose a method with missing policy.
      throw new Error(`gateway method handler is missing a descriptor: ${name}`);
    }
  }
  return descriptors;
}
