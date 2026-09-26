/**
 * Finalizable draft stream controls.
 *
 * Coordinates preview updates, final flushes, clears, and deletion callbacks for channel drafts.
 */
import { formatErrorMessage } from "../infra/errors.js";
import { createDraftStreamLoop } from "./draft-stream-loop.js";

/**
 * Mutable finalization flags shared by draft stream controls and channel adapters.
 */
export type FinalizableDraftStreamState = {
  stopped: boolean;
  final: boolean;
};

type StopAndClearMessageIdParams<T> = {
  stopForClear: () => Promise<void>;
  readMessageId: () => T | undefined;
  clearMessageId: () => void;
};

type ClearFinalizableDraftMessageParams<T> = StopAndClearMessageIdParams<T> & {
  isValidMessageId: (value: unknown) => value is T;
  deleteMessage: (messageId: T) => Promise<boolean | void>;
  onDeleteFailure?: (messageId: T) => void;
  onDeleteSuccess?: (messageId: T) => void;
  warn?: (message: string) => void;
  warnPrefix: string;
};

type DeleteFinalizableDraftMessageParams<T> = Omit<
  ClearFinalizableDraftMessageParams<T>,
  "isValidMessageId" | "onDeleteFailure" | "stopForClear"
>;

type FinalizableDraftLifecycleParams<TMessageId, TUpdate = string> = Omit<
  ClearFinalizableDraftMessageParams<TMessageId>,
  "onDeleteFailure" | "stopForClear"
> & {
  throttleMs: number;
  coalesceInFlight?: boolean;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (value: TUpdate) => Promise<void | boolean>;
  emptyValue?: TUpdate;
  isEmpty?: (value: TUpdate) => boolean;
};

/**
 * Creates controls for streaming preview messages that can be finalized, sealed, or cleared.
 */
export function createFinalizableDraftStreamControls<T = string>(params: {
  throttleMs: number;
  coalesceInFlight?: boolean;
  isStopped: () => boolean;
  isFinal: () => boolean;
  markStopped: () => void;
  markFinal: () => void;
  sendOrEditStreamMessage: (value: T) => Promise<void | boolean>;
  emptyValue?: T;
  isEmpty?: (value: T) => boolean;
}) {
  const loop = createDraftStreamLoop<T>({
    throttleMs: params.throttleMs,
    coalesceInFlight: params.coalesceInFlight,
    isStopped: params.isStopped,
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    ...(params.emptyValue !== undefined ? { emptyValue: params.emptyValue } : {}),
    ...(params.isEmpty ? { isEmpty: params.isEmpty } : {}),
  });

  const update = (value: T) => {
    // Finalized or stopped streams must ignore late model deltas so a deleted/posted draft is
    // not recreated by an in-flight throttle tick.
    if (params.isStopped() || params.isFinal()) {
      return;
    }
    loop.update(value);
  };

  const stop = async (): Promise<void> => {
    // stop finalizes by flushing the latest pending text into the preview message.
    params.markFinal();
    await loop.flush();
  };

  const stopForClear = async (): Promise<void> => {
    // Clearing deletes the preview, so stop the loop without flushing another edit first.
    params.markStopped();
    loop.stop();
    await loop.waitForInFlight();
  };

  const seal = async (): Promise<void> => {
    // Sealing keeps the preview id for callers that already own final delivery/deletion.
    params.markFinal();
    loop.stop();
    await loop.waitForInFlight();
  };

  return {
    loop,
    update,
    stop,
    seal,
    discardPending: stopForClear,
    stopForClear,
  };
}

/**
 * Creates finalizable draft controls backed by a shared mutable state object.
 */
export function createFinalizableDraftStreamControlsForState<T = string>(params: {
  throttleMs: number;
  coalesceInFlight?: boolean;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (value: T) => Promise<void | boolean>;
  emptyValue?: T;
  isEmpty?: (value: T) => boolean;
}) {
  return createFinalizableDraftStreamControls<T>({
    throttleMs: params.throttleMs,
    coalesceInFlight: params.coalesceInFlight,
    isStopped: () => params.state.stopped,
    isFinal: () => params.state.final,
    markStopped: () => {
      params.state.stopped = true;
    },
    markFinal: () => {
      params.state.final = true;
    },
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    ...(params.emptyValue !== undefined ? { emptyValue: params.emptyValue } : {}),
    ...(params.isEmpty ? { isEmpty: params.isEmpty } : {}),
  });
}

/**
 * Stops a draft stream, reads the current preview message id, then clears the stored id.
 */
export async function takeMessageIdAfterStop<T>(
  params: StopAndClearMessageIdParams<T>,
): Promise<T | undefined> {
  await params.stopForClear();
  const messageId = params.readMessageId();
  params.clearMessageId();
  return messageId;
}

async function deleteFinalizableDraftMessage<T>(
  params: DeleteFinalizableDraftMessageParams<T>,
  messageId: T,
): Promise<boolean> {
  try {
    if ((await params.deleteMessage(messageId)) === false) {
      return false;
    }
  } catch (err) {
    params.warn?.(`${params.warnPrefix}: ${formatErrorMessage(err)}`);
    return false;
  }
  try {
    // A replacement preview may become current while deletion is in flight; never clear its ID.
    if (Object.is(params.readMessageId(), messageId)) {
      params.clearMessageId();
    }
    params.onDeleteSuccess?.(messageId);
  } catch (err) {
    params.warn?.(`${params.warnPrefix} after delete: ${formatErrorMessage(err)}`);
  }
  return true;
}

/**
 * Stops a draft stream and deletes its preview message when the stored id is valid.
 * Claims the current id before deletion; stateful callers can retain failures through
 * onDeleteFailure without making overlapping clears delete the same message twice.
 */
export async function clearFinalizableDraftMessage<T>(
  params: ClearFinalizableDraftMessageParams<T>,
): Promise<void> {
  const messageId = await takeMessageIdAfterStop(params);
  if (!params.isValidMessageId(messageId)) {
    return;
  }
  const deleted = await deleteFinalizableDraftMessage(params, messageId);
  if (!deleted) {
    params.onDeleteFailure?.(messageId);
  }
}

/**
 * Builds the standard draft lifecycle used by channel streaming preview implementations.
 */
export function createFinalizableDraftLifecycle<TMessageId, TUpdate = string>(
  params: FinalizableDraftLifecycleParams<TMessageId, TUpdate>,
) {
  const controls = createFinalizableDraftStreamControlsForState<TUpdate>({
    throttleMs: params.throttleMs,
    coalesceInFlight: params.coalesceInFlight,
    state: params.state,
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    ...(params.emptyValue !== undefined ? { emptyValue: params.emptyValue } : {}),
    ...(params.isEmpty ? { isEmpty: params.isEmpty } : {}),
  });
  type Retirement = {
    owner: DeleteFinalizableDraftMessageParams<TMessageId>;
    attempt?: Promise<boolean>;
  };
  const pending = new Map<TMessageId, Retirement>();
  let clearTail = Promise.resolve();

  const claim = (
    messageId: TMessageId,
    owner: DeleteFinalizableDraftMessageParams<TMessageId>,
  ): Retirement => {
    let retirement = pending.get(messageId);
    if (!retirement) {
      retirement = { owner };
      pending.set(messageId, retirement);
    }
    return retirement;
  };
  const attemptDelete = (messageId: TMessageId, retirement: Retirement): Promise<boolean> => {
    retirement.attempt ??= Promise.resolve().then(async () => {
      try {
        const deleted = await deleteFinalizableDraftMessage(retirement.owner, messageId);
        if (deleted && pending.get(messageId) === retirement) {
          pending.delete(messageId);
        }
        return deleted;
      } finally {
        retirement.attempt = undefined;
      }
    });
    return retirement.attempt;
  };
  const drainDeletes = async (retainedId?: TMessageId): Promise<boolean> => {
    const visited = new Set<TMessageId>();
    // Map iteration includes IDs retired while awaiting a DELETE. A failed ID
    // is visited only once; a later drain owns its retry.
    for (const [messageId, retirement] of pending) {
      if (visited.has(messageId) || Object.is(messageId, retainedId)) {
        continue;
      }
      visited.add(messageId);
      await attemptDelete(messageId, retirement);
    }
    return pending.size === 0;
  };
  const retire = async (messageId: TMessageId, options?: { defer?: boolean }): Promise<void> => {
    const retirement = claim(messageId, params);
    if (!options?.defer) {
      // A stale create can retire itself inside the send loop. Waiting for
      // clearTail here would deadlock a clear that is joining that send.
      await attemptDelete(messageId, retirement);
    }
  };
  const serializeCleanup = (operation: () => Promise<void>): Promise<void> => {
    const cleanupRun = clearTail.catch(() => {}).then(operation);
    clearTail = cleanupRun;
    return cleanupRun;
  };
  const clearWithStop = (
    stopForClear: () => Promise<void>,
    messageIdOwner?: Pick<
      StopAndClearMessageIdParams<TMessageId>,
      "readMessageId" | "clearMessageId"
    >,
  ): Promise<void> => {
    const owner = messageIdOwner ? { ...params, ...messageIdOwner } : params;
    return serializeCleanup(async () => {
      await stopForClear();
      const messageId = owner.readMessageId();
      if (owner.isValidMessageId(messageId)) {
        claim(messageId, owner);
      } else {
        owner.clearMessageId();
      }
      await drainDeletes();
    });
  };
  const stop = (): Promise<void> => {
    const previousClear = clearTail.catch(() => {});
    const stopRun = Promise.allSettled([controls.stop(), previousClear]).then(async ([stopped]) => {
      if (stopped.status === "rejected") {
        throw stopped.reason;
      }
      await drainDeletes(params.readMessageId());
    });
    clearTail = stopRun;
    return stopRun;
  };
  return {
    ...controls,
    stop,
    clear: () => clearWithStop(controls.stopForClear),
    clearWithStop,
    retire,
    cleanupPending: (prepareCleanup?: () => void) =>
      serializeCleanup(async () => {
        // Transport disposition must change inside the same order as deletion.
        prepareCleanup?.();
        await drainDeletes(params.readMessageId());
      }),
  };
}
