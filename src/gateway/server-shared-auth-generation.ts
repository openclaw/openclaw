// Gateway shared-auth generation enforcement.
// Disconnects clients when config writes invalidate shared credentials.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import {
  invalidateGatewayPolicyClient,
  type GatewayPolicyClient,
} from "./server/ws-policy-close.js";

/** Gateway client subset relevant to shared auth generation enforcement. */
export type SharedGatewayAuthClient = GatewayPolicyClient & {
  usesSharedGatewayAuth?: boolean;
  sharedGatewaySessionGeneration?: string;
};

export type SharedGatewaySessionGenerationOwnership = {
  generation: string | undefined;
  previousGeneration: string | undefined;
  revision: number;
};

type SharedAuthInvalidation =
  | { kind: "generation"; generation: string | undefined }
  | { kind: "all" };

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
  onInvalidated(generation: string | undefined, listener: () => void): () => void {
    return registerListener(this.#invalidationListeners, (event) => {
      if (event.kind === "all" || event.generation !== generation) {
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

  finalize(ownership: SharedGatewaySessionGenerationOwnership): boolean {
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
    this.publishInvalidation({ kind: "generation", generation: this.requiredGeneration });
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
}): void {
  for (const gatewayClient of params.clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    if (gatewayClient.sharedGatewaySessionGeneration === params.expectedGeneration) {
      continue;
    }
    invalidateGatewayPolicyClient(gatewayClient, {
      reason: "gateway-auth-changed",
      code: 4001,
      message: "gateway auth changed",
      revokeSource: params.revokeSource,
    });
  }
  if (params.revokeSource !== false) {
    params.state?.publishInvalidation(
      params.expectedGeneration === null
        ? { kind: "all" }
        : { kind: "generation", generation: params.expectedGeneration },
    );
  }
}

/** Enforce shared auth generation behavior after a config write. */
export function enforceSharedGatewaySessionGenerationForConfigWrite(params: {
  state: SharedGatewaySessionGenerationState;
  nextConfig: OpenClawConfig;
  resolveRuntimeSnapshotGeneration: () => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
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
  });
}
