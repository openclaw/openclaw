import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  resolveExplicitIncognitoAgentSqliteTarget,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type {
  SessionActor,
  SessionActorTarget,
  SessionActorStorage,
} from "./session-actor-contract.js";
import {
  memorySessionActorRegistry,
  readMemorySessionActorOwner,
} from "./session-actor-memory-registry.js";
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
export function isMemoryBinding(
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

const currentBinding = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionActorStorageBinding"),
  () => new AsyncLocalStorage<SessionActorStorageBinding>(),
);

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
  owner: ReturnType<typeof memorySessionActorRegistry.read>;
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
        : undefined) ?? memorySessionActorRegistry.read({ agentId, path: requestedPath }),
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
