import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../../state/openclaw-agent-db.paths.js";
import type {
  SessionActor,
  SessionActorTarget,
  SessionActorStorage,
} from "./session-actor-contract.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";

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

type BindingScope = {
  sessionKey?: string;
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
  scope: BindingScope,
): SelectedSessionActorStorageBinding | undefined {
  const binding = scope.sessionActor ?? currentBinding.getStore();
  if (!binding) {
    return undefined;
  }
  const sessionKey = scope.sessionKey?.trim();
  if (sessionKey && sessionKey !== binding.actor.target.sessionKey) {
    if (scope.sessionActor || isIncognitoSessionKey(sessionKey)) {
      throw new Error("Session storage binding belongs to another session");
    }
    return undefined;
  }
  const explicit = resolveExplicitIncognitoAgentSqliteTarget(scope.storePath, {
    agentId: scope.agentId,
  });
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
