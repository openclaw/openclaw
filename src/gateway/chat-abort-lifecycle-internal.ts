import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "../sessions/session-controller.lifecycle.js";
import { trackSessionControllerSourceWork } from "../sessions/session-controller.mailbox.js";
import {
  getRpcSourceForGateway,
  isRpcSourceRegistered,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { settlesWithin } from "../shared/settle-within.js";

/** Terminal outcome and physical persistence settle independently. */
export function markChatAbortTerminalOutcome(entry: RpcSourceRef | undefined): void {
  if (entry) {
    entry.adapter.terminalOutcomeObserved = true;
  }
}

/** Retired producers may publish until another exact source owns the protocol ID. */
export function captureChatAbortRegistrationGuard(
  captured: readonly { runId: string; entry?: RpcSourceRef }[],
): () => boolean {
  const owners = captured.map(({ runId, entry }) => ({
    runId,
    entry,
    resolveGatewayContext: entry
      ? getGatewayContextResolver(entry.input)
      : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
  }));
  return () =>
    owners.every(
      ({ runId, entry, resolveGatewayContext }) =>
        (entry && isRpcSourceRegistered(entry)) ||
        !getRpcSourceForGateway(runId, resolveGatewayContext),
    );
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
  entries: readonly RpcSourceRef[] | undefined,
  settled: Promise<void>,
  captured: Pick<ChatAbortTerminalDispatch, "failure"> | undefined,
): void {
  if (!entries || !captured) {
    return;
  }
  const dispatch = Object.assign(captured, { settled });
  for (const entry of entries) {
    terminalDispatchByEntry.set(entry, dispatch);
    trackSessionControllerSourceWork(entry.input, settled);
  }
}

export function isCurrentChatAbortTerminalDispatch(
  entry: object,
  dispatch: Pick<ChatAbortTerminalDispatch, "failure">,
): boolean {
  return terminalDispatchByEntry.get(entry) === dispatch;
}

export function markChatAbortTerminalPersistenceError(entry: object, error: unknown): void {
  if (error === undefined) {
    terminalPersistenceErrorByEntry.delete(entry);
    return;
  }
  terminalPersistenceErrorByEntry.set(entry, error);
}

export function notifyChatAbortControllerRemoved(entry: object): void {
  const waiters = removalWaitersByEntry.get(entry);
  removalWaitersByEntry.delete(entry);
  for (const resolve of waiters ?? []) {
    resolve();
  }
}

/** A requester deadline never releases source, producer, or persistence custody. */
export async function waitForChatAbortAcknowledgment<T>(settlement: Promise<T>): Promise<T> {
  if (!(await settlesWithin(settlement, SESSION_CONTROLLER_DRAIN_TIMEOUT_MS))) {
    throw new Error(
      "Cancellation was requested, but cleanup is still pending. Check the turn status before retrying Stop.",
    );
  }
  return await settlement;
}

/** Cancellation joins accepted dispatch before reporting the captured terminal write outcome. */
export async function waitForChatAbortTerminalPersistence(entry: RpcSourceRef): Promise<void> {
  const dispatch = terminalDispatchByEntry.get(entry);
  const preparedPersistence = entry.adapter.projectSessionTerminalPersistence;
  if (dispatch) {
    await dispatch.settled;
  }
  // Dispatch can attach persistence lazily. Retain an already accepted write
  // even if a later terminal event replaces it while this dispatch is pending.
  const persistence = preparedPersistence ?? entry.adapter.projectSessionTerminalPersistence;
  if (persistence) {
    await persistence;
  }
  if (!persistence && terminalPersistenceErrorByEntry.has(entry)) {
    throw terminalPersistenceErrorByEntry.get(entry);
  }
  if (dispatch?.failure) {
    throw dispatch.failure.error;
  }
  if (!persistence && entry.adapter.projectSessionTerminalPending === true) {
    throw new Error("Session cancellation has no terminal persistence owner");
  }
}

/** Waits for captured run registrations and their terminal persistence owner to leave. */
export async function waitForChatAbortControllerRemoval(params: {
  targets: ReadonlyArray<{ runId: string; entry: RpcSourceRef }>;
  timeoutMs: number;
}): Promise<boolean> {
  const terminalOwnersSettled = () =>
    params.targets.every(
      ({ entry }) =>
        entry.adapter.projectSessionTerminalPending !== true &&
        entry.adapter.projectSessionTerminalPersistence === undefined &&
        !terminalPersistenceErrorByEntry.has(entry),
    );
  const registeredWaiters: Array<{ entry: RpcSourceRef; resolve: () => void }> = [];
  const removals = params.targets.flatMap(({ entry }) => {
    if (!isRpcSourceRegistered(entry)) {
      return [];
    }
    return [
      new Promise<void>((resolve) => {
        const waiters = removalWaitersByEntry.get(entry) ?? new Set<() => void>();
        waiters.add(resolve);
        removalWaitersByEntry.set(entry, waiters);
        registeredWaiters.push({ entry, resolve });
      }),
    ];
  });
  if (removals.length === 0) {
    return terminalOwnersSettled();
  }
  try {
    const removed = await settlesWithin(Promise.all(removals), Math.max(0, params.timeoutMs));
    // Maintenance may retire a registration before its write settles. Registry
    // removal alone must not let a lifecycle mutation bypass that terminal owner.
    return removed && terminalOwnersSettled();
  } finally {
    for (const { entry, resolve } of registeredWaiters) {
      const waiters = removalWaitersByEntry.get(entry);
      waiters?.delete(resolve);
      if (waiters?.size === 0) {
        removalWaitersByEntry.delete(entry);
      }
    }
  }
}
