import type { MemoryOwnerOptions } from "./session-actor-memory-owner-contract.js";
import { memorySessionActorRegistry } from "./session-actor-memory-registry.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";

/** Creation registers synchronously before acquisition can yield to owner cleanup. */
export const memorySessionActorOwners = {
  ...memorySessionActorRegistry,
  get(options: MemoryOwnerOptions) {
    return memorySessionActorRegistry.get(options, createMemorySessionActorOwner);
  },
};
