import { createDeferredCore } from "../shared/deferred.js";
import type {
  ReplyOperation,
  Mutation,
  SessionControllerLifecycle,
} from "./session-controller.contracts.js";
import { notifySessionControllerProtectionReleased } from "./session-controller.lifecycle-projections.js";
import {
  getSessionControllerEntry,
  assertSessionControllerOperation,
  bindSessionControllerEntryTarget,
  getSessionControllerEntryForOperation,
  sessionControllers,
  refreshSessionControllerEntryAliases,
  pruneSessionControllerEntry,
  type SessionControllerEntry,
} from "./session-controller.state.js";
import type { SessionTarget } from "./session-controller.target.js";

export function lifecycle(entry: SessionControllerEntry): SessionControllerLifecycle {
  return (entry.lifecycle ??= {
    targets: new Map(),
    operations: new Set(),
    effects: new Set(),
    mutations: [],
    closures: new Set(),
    changed: createDeferredCore(),
    get blocksTurnAdmission() {
      return (
        this.mutations.length > 0 ||
        this.closures.size > 0 ||
        [...this.operations].some(
          (operation) => operation !== entry.active && !operation.admissionRetired,
        )
      );
    },
  });
}
export function bindTarget(target: SessionTarget): SessionControllerEntry {
  const entry = getSessionControllerEntry(target.sessionKey, target);
  retainTarget(entry, target);
  return entry;
}
function retainTarget(entry: SessionControllerEntry, target: SessionTarget) {
  const targets = lifecycle(entry).targets;
  targets.set(target, (targets.get(target) ?? 0) + 1);
  refreshSessionControllerEntryAliases(entry);
}
export function releaseTarget(entry: SessionControllerEntry, target: SessionTarget) {
  const targets = entry.lifecycle?.targets;
  const count = targets?.get(target) ?? 0;
  if (count > 1) {
    targets?.set(target, count - 1);
  } else {
    targets?.delete(target);
  }
  refreshSessionControllerEntryAliases(entry);
}
export function notify(entry: SessionControllerEntry) {
  const state = entry.lifecycle;
  if (!state) {
    return;
  }
  const changed = state.changed;
  state.changed = createDeferredCore();
  changed.resolve();
  for (const mutation of state.mutations) {
    activate(mutation);
  }
  if (
    !state.targets.size &&
    !state.operations.size &&
    !state.effects.size &&
    !state.mutations.length &&
    !state.closures.size &&
    !entry.active
  ) {
    entry.lifecycle = undefined;
    pruneSessionControllerEntry(entry);
  }
  entry.mailbox?.wake();
}
export function activate(mutation: Mutation) {
  if (
    mutation.phase !== "queued" ||
    mutation.entries.some((entry) => entry.lifecycle?.mutations[0] !== mutation)
  ) {
    return;
  }
  mutation.phase = "active";
  mutation.diagnostic?.hold();
  mutation.diagnostic?.mark("activation");
  for (const entry of mutation.entries) {
    if (entry.active) {
      mutation.operations.add(entry.active);
    }
    for (const operation of entry.lifecycle?.operations ?? []) {
      mutation.operations.add(operation);
    }
  }
  mutation.ready.resolve();
}

/** Raw finishing custody stays on the entry even when physical scope is not known yet. */
export function retainSessionControllerOperation(operation: ReplyOperation): void {
  const entry = getSessionControllerEntryForOperation(operation);
  const state = lifecycle(entry);
  if (state.operations.has(operation)) {
    return;
  }
  state.operations.add(operation);
  const released = () => {
    state.operations.delete(operation);
    refreshSessionControllerEntryAliases(entry);
    notify(entry);
  };
  void operation.ownerSettlement.then(released, released);
}
/** Called only by the producer after resolving its actual owner-settlement receipt. */
export function releaseSessionControllerOperation(operation: ReplyOperation): void {
  for (const entry of sessionControllers.values()) {
    if (entry.lifecycle?.operations.delete(operation)) {
      refreshSessionControllerEntryAliases(entry);
      notify(entry);
    }
  }
}
export function bindSessionControllerTarget(
  operation: ReplyOperation,
  target: SessionTarget,
): void {
  assertSessionControllerOperation(operation);
  const entry = getSessionControllerEntryForOperation(operation);
  if (
    !target.aliases.includes(operation.key) &&
    !target.aliases.some((alias) => entry.aliases.has(alias))
  ) {
    throw new Error("Session target does not cover the admitted controller owner");
  }
  bindSessionControllerEntryTarget(entry, target);
  retainSessionControllerOperation(operation);
  retainTarget(entry, target);
  const released = () => {
    releaseTarget(entry, target);
    notify(entry);
    notifySessionControllerProtectionReleased(target);
  };
  void operation.ownerSettlement.then(released, released);
}
