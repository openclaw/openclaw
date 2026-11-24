import assert from "node:assert/strict";
import { afterEach } from "vitest";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";

export const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
export const actorLifetime = { assertCurrent() {}, assertReadable() {} };
export type MemoryOwner = ReturnType<typeof createMemorySessionActorOwner>;

export function memoryOwnerFixture(
  location: { agentId: string; path: string },
  cleanup?: () => void,
) {
  const owners = new Set<MemoryOwner>();
  afterEach(() => {
    for (const owner of owners) {
      owner.close();
    }
    owners.clear();
    cleanup?.();
  });
  return async (sessionKey: string, owner = createMemorySessionActorOwner(location)) => {
    owners.add(owner);
    const acquire = (key = sessionKey) =>
      owner.acquire({ database: owner.identity, sessionKey: key }, actorLifetime);
    const actor = await acquire();
    assert(actor.storage, "Memory actor has no storage capability");
    return { owner, actor, acquire, store: actor.storage };
  };
}
