import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  deferSqlitePostCommitPublication,
  hasSqlitePostCommitScope,
} from "../../infra/sqlite-post-commit.js";
import {
  captureSessionRowChanges,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { SessionEntry } from "./types.js";

export type SessionSourceCommittedEffect = {
  agentId: string;
  storePath: string;
  databaseIdentity: string;
  changes: readonly SessionRowChange[];
};
type Observer = (effect: SessionSourceCommittedEffect) => void;
export type SessionSourcePendingEffect = {
  owner: object;
  agentId: string;
  storePath: string;
  databaseIdentity: string;
  keys: readonly string[];
  entries?: ReadonlyMap<string, SessionEntry>;
  fullEntries?: ReadonlyMap<string, SessionEntry>;
};
type PendingListener = (effect: SessionSourcePendingEffect, own: boolean, pending: boolean) => void;
const state = resolveGlobalSingleton(Symbol.for("openclaw.sessionSourceEffectAdmissions"), () => ({
  observers: new WeakMap<object, Set<Observer>>(),
  captured: new WeakMap<object, Set<Observer>>(),
  frame: undefined as
    | { observers: Set<Observer>; nestedChanges: Set<SessionRowChange> }
    | undefined,
  observerCount: 0,
  pending: new Map<object, { effect: SessionSourcePendingEffect; observers: Set<Observer> }>(),
  listeners: new Set<{ observer: Observer; listen: PendingListener }>(),
}));

/** Record only an actual, successful root authorization inside a synchronous owner admission. */
export function admitSessionSourceEffects(assertion: () => void): void {
  for (const observer of state.observers.get(assertion) ?? []) {
    state.frame?.observers.add(observer);
  }
}
function capture<T>(run: () => T) {
  const prior = state.frame;
  const observers = new Set<Observer>();
  const frame = { observers, nestedChanges: new Set<SessionRowChange>() };
  state.frame = frame;
  try {
    const result = run();
    // Nested canonical admissions own their certificates; they cannot certify an outer write.
    return { result, ...frame };
  } finally {
    state.frame = prior;
  }
}
export function captureSessionSourceEffectAssertion(assertion: () => void): () => void {
  const guard = () => {
    state.captured.delete(guard);
    const { observers } = capture(assertion);
    state.captured.set(guard, observers);
  };
  return guard;
}
export function observeSessionSourceEffects(assertion: () => void, observer: Observer) {
  const selected = state.observers.get(assertion) ?? new Set<Observer>();
  selected.add(observer);
  state.observers.set(assertion, selected);
  state.observerCount++;
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    selected.delete(observer);
    state.observerCount--;
    if (!selected.size) {
      state.observers.delete(assertion);
    }
  };
}
/** The canonical owner retains final-grant custody until acknowledged settlement or rollback. */
export function retainPendingSessionSourceEffect(
  effect: SessionSourcePendingEffect,
  assertion?: () => void,
): () => void {
  const observers = new Set(assertion ? state.captured.get(assertion) : []);
  state.pending.set(effect.owner, { effect, observers });
  for (const listener of state.listeners) {
    listener.listen(effect, observers.has(listener.observer), true);
  }
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    state.pending.delete(effect.owner);
    for (const listener of state.listeners) {
      listener.listen(effect, observers.has(listener.observer), false);
    }
  };
}
export function observePendingSessionSourceEffects(observer: Observer, listen: PendingListener) {
  const listener = { observer, listen };
  state.listeners.add(listener);
  for (const { effect, observers } of state.pending.values()) {
    listen(effect, observers.has(observer), true);
  }
  return () => {
    state.listeners.delete(listener);
  };
}
/** Called only after confirmed native commit with the exact emitted change objects. */
export function publishSessionSourceEffects(
  assertion: (() => void) | undefined,
  effect: SessionSourceCommittedEffect,
) {
  for (const observer of assertion ? (state.captured.get(assertion) ?? []) : []) {
    observer(effect);
  }
}
export function withNativeSessionSourceEffects<T>(
  database: { db: EngineConnection; agentId: string; path: string },
  run: () => T,
): T {
  if (!state.observerCount) {
    return run();
  }
  if (!hasSqlitePostCommitScope(database.db)) {
    throw new Error("Source effects require canonical transaction publication");
  }
  const identity = findOpenClawAgentDatabaseIdentity(database);
  if (!identity) {
    throw new Error("Source effect physical identity is unavailable");
  }
  const prior = state.frame;
  let emitted: readonly SessionRowChange[] = [];
  try {
    const captured = captureSessionRowChanges(database.db, (changes) => {
      emitted = changes;
      return capture(run);
    });
    deferSqlitePostCommitPublication(database.db, () => {
      for (const observer of captured.result.observers) {
        observer({
          agentId: database.agentId,
          storePath: database.path,
          databaseIdentity: identity.identity,
          changes: captured.changes.filter((change) => !captured.result.nestedChanges.has(change)),
        });
      }
    });
    return captured.result.result;
  } finally {
    // A caught inner failure is not a successful outer source admission.
    for (const change of emitted) {
      prior?.nestedChanges.add(change);
    }
  }
}
