import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  getGatewayContextBindingSlot,
  prepareGatewayContextBindingOwner,
} from "./gateway-context-binding-owner.js";

const gatewayContextBindingKey = Symbol("gatewayContextBinding");
const gatewayContextLifetimeKey = Symbol("gatewayContextLifetime");

class GatewayContextBinding {
  readonly #owner: object;
  #resolver: GatewayContextResolver | undefined;

  constructor(owner: object) {
    this.#owner = owner;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(value: unknown, owner: object): GatewayContextBinding | undefined {
    return typeof value === "object" && value !== null && #owner in value && value.#owner === owner
      ? value
      : undefined;
  }

  static get(binding: GatewayContextBinding): GatewayContextResolver | undefined {
    return binding.#resolver;
  }

  static set(binding: GatewayContextBinding, resolver: GatewayContextResolver | undefined): void {
    binding.#resolver = resolver;
  }
}

class GatewayContextLifetime {
  readonly #owner: GatewayContextResolver;
  readonly #controller = new AbortController();

  constructor(owner: GatewayContextResolver) {
    this.#owner = owner;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(value: unknown, owner: GatewayContextResolver): AbortController | undefined {
    return typeof value === "object" && value !== null && #owner in value && value.#owner === owner
      ? value.#controller
      : undefined;
  }
}

function getGatewayContextBinding(owner: object): GatewayContextBinding | undefined {
  const slot = getGatewayContextBindingSlot(owner);
  const binding: unknown =
    slot && Object.getOwnPropertyDescriptor(slot, gatewayContextBindingKey)?.value;
  return GatewayContextBinding.read(binding, owner);
}

export function getGatewayContextLifetime(resolver: GatewayContextResolver): AbortController {
  const retained: unknown = Object.getOwnPropertyDescriptor(
    resolver,
    gatewayContextLifetimeKey,
  )?.value;
  const existing = GatewayContextLifetime.read(retained, resolver);
  if (existing) {
    return existing;
  }
  // A closed resolver keeps its terminal lifetime even if a late loader borrows it again.
  const lifetime = new GatewayContextLifetime(resolver);
  Object.defineProperty(resolver, gatewayContextLifetimeKey, { value: lifetime });
  return GatewayContextLifetime.read(lifetime, resolver)!;
}

export function bindGatewayContextResolver(
  owner: object,
  resolver: GatewayContextResolver | undefined,
): void {
  if (resolver) {
    prepareGatewayContextBindingOwner(owner);
    let binding = getGatewayContextBinding(owner);
    if (!binding) {
      const slot = getGatewayContextBindingSlot(owner)!;
      binding = new GatewayContextBinding(owner);
      Object.defineProperty(slot, gatewayContextBindingKey, { value: binding });
      Object.freeze(slot);
    }
    GatewayContextBinding.set(binding, resolver);
  }
}

export function getGatewayContextResolver(owner: object): GatewayContextResolver | undefined {
  const binding = getGatewayContextBinding(owner);
  return binding ? GatewayContextBinding.get(binding) : undefined;
}

/** Follows explicit wrapper ownership without invoking any execution resolver. */
export function getCanonicalGatewayContextResolver(
  resolver: GatewayContextResolver,
): GatewayContextResolver | undefined {
  const seen = new Set<GatewayContextResolver>();
  let current = resolver;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = getGatewayContextResolver(current);
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
  const resolver = getGatewayContextResolver(owner);
  // A lifetime wrapper records one canonical host owner; it remains the execution binding.
  return (
    resolver !== undefined && (getGatewayContextResolver(resolver) ?? resolver) === gatewayOwner
  );
}

export function clearGatewayContextResolver(owner: object): boolean {
  const binding = getGatewayContextBinding(owner);
  const bound = binding !== undefined && GatewayContextBinding.get(binding) !== undefined;
  if (binding) {
    GatewayContextBinding.set(binding, undefined);
  }
  return bound;
}

export function getSharedGatewayContextResolver(
  owners: readonly object[],
): GatewayContextResolver | undefined {
  const resolvers = owners.map(getGatewayContextResolver);
  if (resolvers.every((resolve) => !resolve)) {
    return undefined;
  }
  // Recheck every captured fence; a current ambient resolver cannot replace a retired owner.
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
