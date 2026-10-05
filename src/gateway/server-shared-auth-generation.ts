import type { OpenClawConfig } from "../config/types.openclaw.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { captureGatewayAuthPolicy, isGatewayAuthGrantCurrent } from "./auth-policy.js";
import type { GatewayAuthPolicy } from "./auth-policy.types.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import {
  invalidateGatewayPolicyClient,
  type GatewayPolicyClient,
} from "./server/ws-policy-close.js";

export type SharedGatewayAuthClient = GatewayPolicyClient & {
  usesSharedGatewayAuth?: boolean;
  sharedGatewaySessionGeneration?: string;
  authPolicy?: GatewayAuthPolicy;
};

type SharedAuthConfigTransition = {
  previous: OpenClawConfig;
  next: OpenClawConfig;
};

export type SharedGatewaySessionGenerationOwnership = {
  generation: string | undefined;
  previousGeneration: string | undefined;
  revision: number;
};

type SharedAuthInvalidation =
  | { kind: "generation"; generation: string | undefined }
  | { kind: "policy"; config: OpenClawConfig }
  | { kind: "all" };

function isProxyPolicyTransition(transition: SharedAuthConfigTransition | undefined): boolean {
  return Boolean(
    transition?.previous.gateway?.auth?.mode === "trusted-proxy" &&
    transition.previous.gateway.auth.trustedProxy &&
    transition.next.gateway?.auth?.mode === "trusted-proxy" &&
    transition.next.gateway.auth.trustedProxy,
  );
}

function resolveSharedAuthInvalidation(
  generation: string | undefined | null,
  transition?: SharedAuthConfigTransition,
): SharedAuthInvalidation | undefined {
  if (generation === null) {
    return { kind: "all" };
  }
  // Proxy runs can outlive several handshake generations without losing their grant.
  if (transition && isProxyPolicyTransition(transition)) {
    const allowUsers = (config: OpenClawConfig) =>
      JSON.stringify([...new Set(config.gateway?.auth?.trustedProxy?.allowUsers ?? [])].toSorted());
    const fallbackGrant = (config: OpenClawConfig) =>
      captureGatewayAuthPolicy(config, { role: "operator", authMethod: "password" })
        .grantGeneration;
    return allowUsers(transition.previous) === allowUsers(transition.next) &&
      fallbackGrant(transition.previous) === fallbackGrant(transition.next)
      ? undefined
      : { kind: "policy", config: transition.next };
  }
  return { kind: "generation", generation };
}

const contextGenerations = new WeakMap<object, SharedGatewaySessionGenerationState>();

export function bindGatewaySharedAuthGeneration(
  context: object,
  state: SharedGatewaySessionGenerationState,
) {
  contextGenerations.set(context, state);
}

export function readGatewaySharedAuthGeneration(context: object) {
  return contextGenerations.get(context);
}

/** One Gateway owns its generation fields, revision and read-only admission capability. */
export class SharedGatewaySessionGenerationState {
  #current: string | undefined;
  #required: string | undefined | null;
  #revision = 0;
  readonly #reader: GenerationReader;
  readonly #invalidationListeners = new Set<(event: SharedAuthInvalidation) => void>();

  constructor(initial: { current: string | undefined; required: string | undefined | null }) {
    this.#current = initial.current;
    this.#required = initial.required;
    this.#reader = () => (this.#required === null ? this.#current : this.#required);
    Object.defineProperty(this.#reader, generationReaderStateKey, {
      value: new GenerationReaderBinding(this.#reader, this),
    });
  }

  get current(): string | undefined {
    return this.#current;
  }

  get required(): string | undefined | null {
    return this.#required;
  }

  get requiredGeneration(): string | undefined {
    return this.#required === null ? this.#current : this.#required;
  }

  get reader(): GenerationReader {
    return this.#reader;
  }

  static fromReader(
    read: GenerationReader | undefined,
  ): SharedGatewaySessionGenerationState | undefined {
    const binding: unknown =
      read && Object.getOwnPropertyDescriptor(read, generationReaderStateKey)?.value;
    return read ? GenerationReaderBinding.read(binding, read) : undefined;
  }

  /** Follow committed policy even after the originating client leaves the socket set. */
  onInvalidated(
    generation: string | undefined,
    listener: () => void,
    authPolicy?: GatewayAuthPolicy,
  ): () => void {
    return registerListener(this.#invalidationListeners, (event) => {
      if (
        event.kind === "policy"
          ? !authPolicy || !isGatewayAuthGrantCurrent(authPolicy, event.config)
          : event.kind === "all" || event.generation !== generation
      ) {
        listener();
      }
    });
  }

  publishInvalidation(event: SharedAuthInvalidation): void {
    notifyListeners(this.#invalidationListeners, event);
  }

  capture(): SharedGatewaySessionGenerationOwnership {
    return {
      generation: this.#current,
      previousGeneration: this.#current,
      revision: this.#revision,
    };
  }

  owns(ownership: SharedGatewaySessionGenerationOwnership): boolean {
    return this.#revision === ownership.revision;
  }

  claim(
    ownership: SharedGatewaySessionGenerationOwnership,
    generation: string | undefined,
  ): SharedGatewaySessionGenerationOwnership | null {
    if (!this.owns(ownership)) {
      return null;
    }
    const previousGeneration = this.#current;
    this.#current = generation;
    return { generation, previousGeneration, revision: ++this.#revision };
  }

  publish(next: { current: string | undefined; required: string | undefined | null }): void {
    this.#current = next.current;
    this.#required = next.required;
    this.#revision++;
  }

  replace(
    ownership: SharedGatewaySessionGenerationOwnership,
    next: { current: string | undefined; required: string | undefined | null },
  ): boolean {
    if (!this.owns(ownership)) {
      return false;
    }
    this.publish(next);
    return true;
  }

  restoreCurrent(
    ownership: SharedGatewaySessionGenerationOwnership,
    current: string | undefined,
  ): boolean {
    if (!this.owns(ownership)) {
      return false;
    }
    this.#current = current;
    this.#revision++;
    return true;
  }

  setRequired(
    ownership: SharedGatewaySessionGenerationOwnership,
    required: string | undefined | null,
  ): SharedGatewaySessionGenerationOwnership | null {
    if (!this.owns(ownership)) {
      return null;
    }
    this.#required = required;
    this.#revision++;
    return this.capture();
  }

  finalize(
    ownership: SharedGatewaySessionGenerationOwnership,
    transition?: SharedAuthConfigTransition,
  ): boolean {
    if (!this.owns(ownership)) {
      return false;
    }
    this.#current = ownership.generation;
    if (
      this.#required === ownership.generation ||
      (this.#required !== null && ownership.previousGeneration !== ownership.generation)
    ) {
      this.#required = null;
    }
    this.#revision++;
    const invalidation = resolveSharedAuthInvalidation(this.requiredGeneration, transition);
    if (invalidation) {
      this.publishInvalidation(invalidation);
    }
    return true;
  }
}

const generationReaderStateKey = Symbol("sharedGatewaySessionGenerationReaderState");
type GenerationReader = () => string | undefined;

class GenerationReaderBinding {
  readonly #owner: GenerationReader;
  readonly #state: SharedGatewaySessionGenerationState;

  constructor(owner: GenerationReader, state: SharedGatewaySessionGenerationState) {
    this.#owner = owner;
    this.#state = state;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(
    value: unknown,
    owner: GenerationReader,
  ): SharedGatewaySessionGenerationState | undefined {
    return typeof value === "object" && value !== null && #owner in value && value.#owner === owner
      ? value.#state
      : undefined;
  }
}

/** Disconnect stale shared-auth clients; null revokes every generation. */
export function disconnectStaleSharedGatewayAuthClients(params: {
  clients: Iterable<SharedGatewayAuthClient>;
  expectedGeneration: string | undefined | null;
  state?: SharedGatewaySessionGenerationState;
  revokeSource?: boolean;
  transition?: SharedAuthConfigTransition;
}): void {
  const proxyPolicyTransition =
    params.expectedGeneration !== null && isProxyPolicyTransition(params.transition);
  for (const gatewayClient of params.clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    const grantRevoked =
      proxyPolicyTransition &&
      gatewayClient.authPolicy !== undefined &&
      !isGatewayAuthGrantCurrent(gatewayClient.authPolicy, params.transition?.next);
    if (
      gatewayClient.sharedGatewaySessionGeneration === params.expectedGeneration &&
      !grantRevoked
    ) {
      continue;
    }
    invalidateGatewayPolicyClient(gatewayClient, {
      reason: "gateway-auth-changed",
      code: 4001,
      message: "gateway auth changed",
      revokeSource:
        params.revokeSource !== false &&
        (!proxyPolicyTransition || !gatewayClient.authPolicy || grantRevoked),
    });
  }
  if (params.revokeSource !== false) {
    const invalidation = resolveSharedAuthInvalidation(
      params.expectedGeneration,
      params.transition,
    );
    if (invalidation) {
      params.state?.publishInvalidation(invalidation);
    }
  }
}

export function enforceSharedGatewaySessionGenerationForConfigWrite(params: {
  state: SharedGatewaySessionGenerationState;
  nextConfig: OpenClawConfig;
  resolveRuntimeSnapshotGeneration: () => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
  transition?: SharedAuthConfigTransition;
}): void {
  const reloadMode = resolveGatewayReloadSettings(params.nextConfig).mode;
  const nextSharedGatewaySessionGeneration = params.resolveRuntimeSnapshotGeneration();
  params.state.publish({
    current: nextSharedGatewaySessionGeneration,
    required: reloadMode === "off" ? nextSharedGatewaySessionGeneration : null,
  });
  disconnectStaleSharedGatewayAuthClients({
    state: params.state,
    clients: params.clients,
    expectedGeneration: nextSharedGatewaySessionGeneration,
    transition: params.transition,
  });
}
