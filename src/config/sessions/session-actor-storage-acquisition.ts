import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionActor, SessionActorLifetime } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  captureSessionActorStorageOwner,
  isMemoryBinding,
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
  type SessionActorStorageScope,
} from "./session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";

export type SessionActorStorageAcquisitionOptions = {
  lifetime: SessionActorLifetime;
  authority: SessionActorStorageAuthority;
  /** Only entry creation may allocate a previously absent memory owner/session. */
  create?: boolean;
};

/** Select once at the root; the returned handle owns its release. */
export async function acquireSessionActorStorage(
  scope: SessionActorStorageScope,
  options: SessionActorStorageAcquisitionOptions,
): Promise<SelectedSessionActorStorageBinding | undefined> {
  options.lifetime.assertAdmission?.();
  options.lifetime.assertCurrent();
  const captured = captureSessionActorStorageOwner(scope, options.authority);
  if (!captured) {
    return undefined;
  }
  const selected = captured.binding;
  const selectedOwner =
    selected && selected.agentId === captured.agentId && selected.path === captured.path;
  const owner =
    captured.owner ??
    (options.create && !selectedOwner ? memorySessionActorOwners.get(captured) : undefined);
  let sessionKey = scope.sessionKey
    ? resolveSqliteSessionKey(scope.sessionKey, captured.agentId)
    : undefined;
  if (!sessionKey && scope.sessionId) {
    sessionKey =
      owner?.readSessionById(scope.sessionId, captured.authority)?.sessionKey ??
      (selectedOwner
        ? selected.actor.storage?.readCurrent(
            { type: "session.entry.readById", input: { sessionId: scope.sessionId } },
            captured.authority,
          )?.sessionKey
        : undefined);
  }
  if (!sessionKey) {
    return undefined;
  }
  let actor: SessionActor | undefined;
  if (owner) {
    if (selected && selected.agentId === captured.agentId && selected.path === captured.path) {
      selected.actor.assertReadable();
    }
    actor = options.create
      ? await owner.acquire({ database: owner.identity, sessionKey }, options.lifetime)
      : await owner.acquireExisting(sessionKey, options.lifetime);
  } else if (selected && selected.agentId === captured.agentId && selected.path === captured.path) {
    const storage = selected.actor.storage;
    if (!storage) {
      throw new Error("Selected memory actor has no storage capability");
    }
    if (
      options.create ||
      storage.readCurrent({ type: "session.entry.read", input: { sessionKey } }, captured.authority)
    ) {
      actor = await storage.acquire(sessionKey, options.lifetime);
    }
  }
  if (!actor) {
    return undefined;
  }
  const binding = {
    actor,
    authority: captured.authority,
    agentId: captured.agentId,
    path: captured.path,
  };
  if (!isMemoryBinding(binding)) {
    await actor.release();
    throw new Error("Memory acquisition selected another backend");
  }
  return binding;
}

/** Async roots retain exactly one handle and bind descendants until all accepted work settles. */
export async function withSessionActorStorage<T>(
  scope: SessionActorStorageScope,
  options: SessionActorStorageAcquisitionOptions,
  consume: (binding: SelectedSessionActorStorageBinding) => T | Promise<T>,
): Promise<T | undefined> {
  const binding = await acquireSessionActorStorage(scope, options);
  if (!binding) {
    return undefined;
  }
  try {
    return await runWithSessionActorStorage(binding, () => consume(binding));
  } finally {
    await binding.actor.release();
  }
}
