import path from "node:path";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SessionActor } from "./session-actor-contract.js";
import type {
  MemoryOwnerOptions,
  MemorySessionActorOwner,
} from "./session-actor-memory-owner-contract.js";

// Source and bundled SDK graphs must address the same memory-only sessions.
const owners = resolveGlobalMap<string, MemorySessionActorOwner>(
  Symbol.for("openclaw.memorySessionActorOwners"),
);
const actorOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.memorySessionActorHandles"),
  () => new WeakMap<SessionActor, MemorySessionActorOwner>(),
);

/** Selected handles keep their actual owner, even after a same-path replacement. */
export function readMemorySessionActorOwner(actor: SessionActor) {
  return actorOwners.get(actor);
}

export function registerMemorySessionActorHandle(
  actor: SessionActor,
  owner: MemorySessionActorOwner,
) {
  actorOwners.set(actor, owner);
}

function ownerLocation(options: MemoryOwnerOptions) {
  // Match the native incognito sentinel's lexical identity; there is no file to inspect.
  return { agentId: normalizeAgentId(options.agentId), path: path.resolve(options.path) };
}

function ownerKey(options: MemoryOwnerOptions) {
  return JSON.stringify([options.agentId, options.path]);
}

/** Ownership reads and cleanup must not load the actor factory. */
export const memorySessionActorRegistry = {
  list(): readonly MemorySessionActorOwner[] {
    return [...owners.values()];
  },
  get(
    options: MemoryOwnerOptions,
    create: (options: MemoryOwnerOptions) => MemorySessionActorOwner,
  ): MemorySessionActorOwner {
    const location = ownerLocation(options);
    const key = ownerKey(location);
    let owner = owners.get(key);
    if (!owner) {
      owner = create(location);
      owners.set(key, owner);
    }
    return owner;
  },
  read(options: MemoryOwnerOptions): MemorySessionActorOwner | undefined {
    return owners.get(ownerKey(ownerLocation(options)));
  },
  closeSession(options: MemoryOwnerOptions, sessionKey: string): void {
    owners.get(ownerKey(ownerLocation(options)))?.closeSession(sessionKey);
  },
  closeDatabase(options: MemoryOwnerOptions): void {
    const key = ownerKey(ownerLocation(options));
    owners.get(key)?.close();
    owners.delete(key);
  },
  reset(): void {
    for (const owner of owners.values()) {
      owner.close();
    }
    owners.clear();
  },
};
