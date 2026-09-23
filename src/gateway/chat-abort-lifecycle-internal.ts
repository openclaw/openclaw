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

export function notifyChatAbortControllerRemoved(entry: object): void {
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
    params.targets.every(
      ({ entry }) =>
        entry.projectSessionTerminalPending !== true &&
        entry.projectSessionTerminalPersistence === undefined &&
        !terminalPersistenceErrorByEntry.has(entry),
    );
  const registeredWaiters: Array<{ entry: TEntry; resolve: () => void }> = [];
  const removals = params.targets.flatMap(({ runId, entry }) => {
    if (params.entries.get(runId) !== entry) {
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const removed = await Promise.race([
      Promise.all(removals).then(() => true),
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
