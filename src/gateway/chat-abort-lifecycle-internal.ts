import { AsyncLocalStorage } from "node:async_hooks";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";

const executionContext = resolveGlobalSingleton(
  Symbol.for("openclaw.chatAbortExecutionContext"),
  () => new AsyncLocalStorage<ChatAbortControllerEntry>(),
);

export function isCurrentChatAbortExecution(entry: object): boolean {
  const current = executionContext.getStore();
  return current === entry && current.executionSettlement?.status === "pending";
}

/** Capture one exact registration; a same-key successor is never its completion owner. */
export function captureChatAbortExecution(params: {
  entries: ReadonlyMap<string, ChatAbortControllerEntry>;
  runId: string;
  sessionKey: string;
  sessionId: string | undefined;
  lifecycleGeneration?: string;
}): ChatAbortControllerEntry | undefined {
  const entry = params.entries.get(params.runId);
  return entry &&
    entry.kind === "agent" &&
    entry.sessionKey === params.sessionKey &&
    entry.sessionId === params.sessionId &&
    (params.lifecycleGeneration === undefined ||
      entry.lifecycleGeneration === params.lifecycleGeneration)
    ? entry
    : undefined;
}

/** Bind the raw execution tail before its logical registration can retire. */
export function runWithChatAbortExecution(
  entry: ChatAbortControllerEntry | undefined,
  run: () => Promise<void>,
  cleanup: () => void,
): Promise<void> {
  if (!entry) {
    return run();
  }
  if (entry.executionSettlement) {
    throw new Error("Chat execution already has a settlement owner");
  }
  const { promise: completion, resolve, reject } = createDeferredCore();
  const settlement: NonNullable<ChatAbortControllerEntry["executionSettlement"]> = {
    completion,
    status: "pending",
  };
  entry.executionSettlement = settlement;
  void completion.then(
    () => {
      settlement.status = "fulfilled";
      if (entry.executionSettlement === settlement && entry.registrationCleanupRequested) {
        cleanup();
      }
    },
    () => {
      // Keep the rejected tail observable; absence must never certify successful cleanup.
      settlement.status = "rejected";
    },
  );
  try {
    // Invocation stays immediate, with custody installed before synchronous cleanup.
    void executionContext.run(entry, run).then(resolve, reject);
  } catch (error) {
    reject(error);
  }
  return completion;
}

export function removeChatAbortControllerEntry(
  entries: Map<string, ChatAbortControllerEntry>,
  runId: string,
  expectedEntry?: ChatAbortControllerEntry,
): boolean {
  const entry = entries.get(runId);
  if (!entry || (expectedEntry && entry !== expectedEntry)) {
    return false;
  }
  const pending = entry.pendingTimeoutCompletion;
  if (pending) {
    if (isFutureDateTimestampMs(pending.expiresAtMs, { nowMs: Date.now() })) {
      return false;
    }
    // Orphan cleanup must record the known timeout before revoking this exact receipt owner.
    entry.pendingTimeoutCompletion = undefined;
    pending.settle();
    if (entries.get(runId) !== entry) {
      return false;
    }
  }
  if (entry.executionSettlement && entry.executionSettlement.status !== "fulfilled") {
    return false;
  }
  entries.delete(runId);
  try {
    entry.onRemoved?.();
  } catch {
    // Removal owns state cleanup even if a caller-provided release hook fails.
  } finally {
    notifyChatAbortControllerRemoved(entry);
  }
  return true;
}

const terminalPersistenceErrorByEntry = new WeakMap<object, unknown>();
export type ChatAbortTerminalDispatch = {
  settled: Promise<void>;
  failure?: { error: unknown };
};
const terminalDispatchByEntry = new WeakMap<object, ChatAbortTerminalDispatch>();
const removalWaitersByEntry = new WeakMap<object, Set<() => void>>();

/** Retain the subscription owner's receipt on the exact captured registration. */
export function bindChatAbortTerminalDispatch(
  entries: readonly object[] | undefined,
  settled: Promise<void>,
  captured: Pick<ChatAbortTerminalDispatch, "failure"> | undefined,
): void {
  if (!entries || !captured) {
    return;
  }
  const dispatch = Object.assign(captured, { settled });
  for (const entry of entries) {
    terminalDispatchByEntry.set(entry, dispatch);
  }
}

export function markChatAbortTerminalPersistenceError(entry: object, error: unknown): void {
  if (error === undefined) {
    terminalPersistenceErrorByEntry.delete(entry);
    return;
  }
  terminalPersistenceErrorByEntry.set(entry, error);
}

function notifyChatAbortControllerRemoved(entry: object): void {
  const waiters = removalWaitersByEntry.get(entry);
  removalWaitersByEntry.delete(entry);
  for (const resolve of waiters ?? []) {
    resolve();
  }
}

/** Cancellation joins terminal dispatch before inspecting its write or intentional no-write. */
export async function waitForChatAbortTerminalPersistence(entry: {
  projectSessionTerminalPending?: boolean;
  projectSessionTerminalPersistence?: Promise<void>;
}): Promise<void> {
  const dispatch = terminalDispatchByEntry.get(entry);
  const preparedPersistence = entry.projectSessionTerminalPersistence;
  if (dispatch) {
    await dispatch.settled;
  }
  // Dispatch can attach persistence lazily. Retain an already accepted write
  // even if a later terminal event replaces it while this dispatch is pending.
  const persistence = preparedPersistence ?? entry.projectSessionTerminalPersistence;
  if (persistence) {
    await persistence;
  }
  if (!persistence && terminalPersistenceErrorByEntry.has(entry)) {
    throw terminalPersistenceErrorByEntry.get(entry);
  }
  if (dispatch?.failure) {
    throw dispatch.failure.error;
  }
  if (!persistence && entry.projectSessionTerminalPending === true) {
    throw new Error("Session cancellation has no terminal persistence owner");
  }
}

export function isChatAbortTerminalPersistenceSettled(entry: {
  projectSessionTerminalPending?: boolean;
  projectSessionTerminalPersistence?: Promise<void>;
}): boolean {
  return (
    entry.projectSessionTerminalPending !== true &&
    entry.projectSessionTerminalPersistence === undefined &&
    !terminalPersistenceErrorByEntry.has(entry)
  );
}

/** Waits for captured run registrations and their terminal persistence owner to leave. */
export async function waitForChatAbortControllerRemoval<
  TEntry extends {
    projectSessionTerminalPending?: boolean;
    projectSessionTerminalPersistence?: Promise<void>;
  },
>(params: {
  entries: ReadonlyMap<string, TEntry>;
  targets: ReadonlyArray<{ runId: string; entry: TEntry }>;
  timeoutMs: number;
}): Promise<boolean> {
  const terminalOwnersSettled = () =>
    params.targets.every(({ entry }) => isChatAbortTerminalPersistenceSettled(entry));
  const registeredWaiters: Array<{ entry: TEntry; resolve: () => void }> = [];
  const settlements = params.targets.flatMap(({ runId, entry }) => {
    if (isCurrentChatAbortExecution(entry)) {
      // A disposer skips its own raw tail, but must still join its terminal writer.
      return [
        // Target capture precedes the synchronous abort that installs its terminal owner.
        Promise.resolve()
          .then(() => waitForChatAbortTerminalPersistence(entry))
          .then(
            () => true,
            () => false,
          ),
      ];
    }
    if (params.entries.get(runId) !== entry) {
      return [];
    }
    return [
      new Promise<boolean>((resolve) => {
        const removed = () => resolve(true);
        const waiters = removalWaitersByEntry.get(entry) ?? new Set<() => void>();
        waiters.add(removed);
        removalWaitersByEntry.set(entry, waiters);
        registeredWaiters.push({ entry, resolve: removed });
      }),
    ];
  });
  if (settlements.length === 0) {
    return terminalOwnersSettled();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const removed = await Promise.race([
      Promise.all(settlements).then((results) => results.every(Boolean)),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, params.timeoutMs));
        timer.unref?.();
      }),
    ]);
    // Maintenance may retire a registration before its write settles. Registry
    // removal alone must not let a lifecycle mutation bypass that terminal owner.
    return removed && terminalOwnersSettled();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    for (const { entry, resolve } of registeredWaiters) {
      const waiters = removalWaitersByEntry.get(entry);
      waiters?.delete(resolve);
      if (waiters?.size === 0) {
        removalWaitersByEntry.delete(entry);
      }
    }
  }
}
