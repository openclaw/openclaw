import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  resolveExplicitIncognitoAgentSqliteTarget,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type {
  SessionActor,
  SessionActorTarget,
  SessionActorLifetime,
  SessionActorStorage,
} from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { readMemorySessionActorOwner } from "./session-actor-memory.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";
import type { SessionEntryProjection } from "./session-entry-snapshot-values.js";

/** A caller-selected memory owner; resolving a binding never acquires another backend. */
export type SessionActorStorageBinding = {
  actor: SessionActor;
  authority: SessionActorStorageAuthority;
  agentId: string;
  path: string;
};

export type SelectedSessionActorStorageBinding = Omit<SessionActorStorageBinding, "actor"> & {
  actor: SessionActor & {
    target: SessionActorTarget & {
      database: Extract<SessionActorTarget["database"], { kind: "memory" }>;
    };
    storage: SessionActorStorage;
  };
};
function isMemoryBinding(
  binding: SessionActorStorageBinding,
): binding is SelectedSessionActorStorageBinding {
  return binding.actor.target.database.kind === "memory" && binding.actor.storage !== undefined;
}

export type SessionActorStorageScope = {
  sessionKey?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  agentId?: string;
  storePath?: string;
  sessionActor?: SessionActorStorageBinding;
};

const currentBinding = new AsyncLocalStorage<SessionActorStorageBinding>();

export function runWithSessionActorStorage<T>(
  binding: SessionActorStorageBinding,
  run: () => T,
): T {
  if (!isMemoryBinding(binding)) {
    throw new Error("Session storage binding requires a memory actor");
  }
  return currentBinding.run(binding, run);
}

/** Borrow the selected actor for an exact logical session, never a native fallback. */
export function getSessionActorStorageBinding(
  scope: SessionActorStorageScope,
): SelectedSessionActorStorageBinding | undefined {
  const binding = scope.sessionActor ?? currentBinding.getStore();
  if (!binding) {
    return undefined;
  }
  const sessionKey = scope.sessionKey
    ? resolveSqliteSessionKey(scope.sessionKey, binding.agentId)
    : undefined;
  if (sessionKey && sessionKey !== binding.actor.target.sessionKey) {
    if (scope.sessionActor || isIncognitoSessionKey(sessionKey)) {
      throw new Error("Session storage binding belongs to another session");
    }
    return undefined;
  }
  const explicit = resolveExplicitIncognitoAgentSqliteTarget(scope.storePath, {
    agentId: scope.agentId,
  });
  if (scope.storePath && !explicit && !isIncognitoSessionKey(scope.sessionKey)) {
    return undefined;
  }
  if (
    (scope.agentId && scope.agentId !== binding.agentId) ||
    (explicit && explicit.path !== path.resolve(binding.path))
  ) {
    throw new Error("Session storage binding belongs to another owner");
  }
  if (!isMemoryBinding(binding)) {
    throw new Error("Session storage binding requires a memory actor");
  }
  return binding;
}

export type CapturedSessionActorStorageOwner = {
  owner: ReturnType<typeof memorySessionActorOwners.read>;
  binding?: SessionActorStorageBinding;
  authority: SessionActorStorageAuthority;
  agentId: string;
  path: string;
};

/** Capture an existing namespace; absence is a fact, never permission to open SQLite. */
export function captureSessionActorStorageOwner(
  scope: SessionActorStorageScope,
): (CapturedSessionActorStorageOwner & { binding: SessionActorStorageBinding }) | undefined;
export function captureSessionActorStorageOwner(
  scope: SessionActorStorageScope,
  authority: SessionActorStorageAuthority,
): CapturedSessionActorStorageOwner | undefined;
export function captureSessionActorStorageOwner(
  scope: SessionActorStorageScope,
  authority?: SessionActorStorageAuthority,
): CapturedSessionActorStorageOwner | undefined {
  const selected = scope.sessionActor ?? currentBinding.getStore();
  const explicit = resolveExplicitIncognitoAgentSqliteTarget(scope.storePath, {
    agentId: scope.agentId,
  });
  if (scope.storePath && !explicit && !isIncognitoSessionKey(scope.sessionKey)) {
    return undefined;
  }
  if (!selected && (!authority || (!isIncognitoSessionKey(scope.sessionKey) && !explicit))) {
    return undefined;
  }
  if (scope.sessionKey && !isIncognitoSessionKey(scope.sessionKey) && !explicit) {
    return undefined;
  }
  const agentId =
    scope.agentId ??
    explicit?.agentId ??
    (scope.sessionKey ? resolveAgentIdFromSessionKey(scope.sessionKey) : selected?.agentId);
  if (!agentId) {
    return undefined;
  }
  const root = selected && path.resolve(selected.path, "../../../..");
  const requestedPath =
    explicit?.path ??
    (selected?.agentId === agentId && !scope.env ? selected.path : undefined) ??
    resolveIncognitoOpenClawAgentSqlitePath({
      agentId,
      env: scope.env ?? (root ? { OPENCLAW_STATE_DIR: root } : undefined),
    });
  if (root && path.resolve(requestedPath, "../../../..") !== root) {
    throw new Error("Session storage owner belongs to another state root");
  }
  const caller = selected?.authority ?? authority!;
  const currentAuthority =
    authority && selected
      ? {
          authorize: (...args: Parameters<typeof caller.authorize>) => caller.authorize(...args),
          assertCurrent() {
            caller.assertCurrent();
            authority.assertCurrent();
          },
        }
      : caller;
  return {
    owner:
      (selected?.agentId === agentId && selected.path === requestedPath
        ? readMemorySessionActorOwner(selected.actor)
        : undefined) ?? memorySessionActorOwners.read({ agentId, path: requestedPath }),
    binding: selected,
    authority: currentAuthority,
    agentId,
    path: requestedPath,
  };
}

/** Read the captured namespace, including directly constructed selected owners. */
export function readCapturedSessionActorEntry(
  captured: CapturedSessionActorStorageOwner,
  sessionKey: string,
) {
  if (captured.owner) {
    return captured.owner.readSession(sessionKey, captured.authority)?.entry;
  }
  const selected = captured.binding;
  if (
    !selected ||
    selected.agentId !== captured.agentId ||
    path.resolve(selected.path) !== path.resolve(captured.path)
  ) {
    return undefined;
  }
  return selected.actor.storage?.readCurrent(
    { type: "session.entry.read", input: { sessionKey } },
    captured.authority,
  );
}

/** Enumerate the already-selected memory namespace without opening another backend. */
export function readCapturedSessionActorEntries(
  captured: CapturedSessionActorStorageOwner,
  projection?: SessionEntryProjection,
) {
  if (captured.owner) {
    return captured.owner.listSessionEntries(captured.authority, projection);
  }
  const selected = captured.binding;
  if (
    !selected ||
    selected.agentId !== captured.agentId ||
    path.resolve(selected.path) !== path.resolve(captured.path)
  ) {
    return [];
  }
  return (
    selected.actor.storage?.readCurrent(
      { type: "session.entries.read", input: { projection } },
      captured.authority,
    ) ?? []
  );
}

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
