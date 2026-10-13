import path from "node:path";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";

type MemoryOwnerOptions = { agentId: string; path: string };
type MemoryOwner = ReturnType<typeof createMemorySessionActorOwner>;

const owners = new Map<string, MemoryOwner>();

function ownerLocation(options: MemoryOwnerOptions) {
  // Match the native incognito sentinel's lexical identity; there is no file to inspect.
  return { agentId: normalizeAgentId(options.agentId), path: path.resolve(options.path) };
}

function ownerKey(options: MemoryOwnerOptions) {
  return JSON.stringify([options.agentId, options.path]);
}

/**
 * The memory backend's process-held owner and lifecycle. Native incognito callers
 * move here together at cutover; this registry never imports or mirrors their state.
 */
export const memorySessionActorOwners = {
  list(): readonly MemoryOwner[] {
    return [...owners.values()];
  },
  get(options: MemoryOwnerOptions): MemoryOwner {
    const location = ownerLocation(options);
    const key = ownerKey(location);
    let owner = owners.get(key);
    if (!owner) {
      owner = createMemorySessionActorOwner(location);
      owners.set(key, owner);
    }
    return owner;
  },
  read(options: MemoryOwnerOptions): MemoryOwner | undefined {
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
