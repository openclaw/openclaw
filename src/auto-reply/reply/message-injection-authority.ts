import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const injectionQueues = resolveGlobalSingleton(
  Symbol.for("openclaw.messageInjectionQueues"),
  () => new WeakMap<object, KeyedAsyncQueue>(),
);

type MessageInjectionAdmission = <T>(consume: () => T) => Promise<T>;
const injectionAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.messageInjectionAdmissions"),
  () => new WeakMap<() => Promise<void>, MessageInjectionAdmission>(),
);
const questionAssertionFrame = resolveGlobalSingleton(
  Symbol.for("openclaw.messageInjectionQuestionAssertionFrame"),
  () => ({ active: false }),
);

/** Released adapters may wrap the callback; scope only its synchronous question assertion. */
export function withQuestionInputAssertion(assertCurrent: () => void): void {
  const previous = questionAssertionFrame.active;
  questionAssertionFrame.active = true;
  try {
    assertCurrent();
  } finally {
    questionAssertionFrame.active = previous;
  }
}

/** Queue predicates remain final; question grants retain the original policy/source assertion. */
export function createLegacyMessageInjectionAuthority(
  assertCurrent: () => void,
  assertQueueCurrent: () => void,
): () => void {
  return createMessageInjectionAuthority(() => {
    assertCurrent();
    if (!questionAssertionFrame.active) {
      assertQueueCurrent();
      assertCurrent();
    }
    return true;
  });
}

/** Bind final enqueue custody to this exact host-owned preparation. */
export function bindMessageInjectionAdmission(
  prepare: () => Promise<void>,
  admission: MessageInjectionAdmission,
): void {
  injectionAdmissions.set(prepare, admission);
}

export async function withMessageInjectionAdmission<T>(
  prepare: (() => Promise<void>) | undefined,
  consume: () => T,
): Promise<T> {
  let consumed = false;
  const consumeSync = () => {
    if (consumed) {
      throw new Error("Message injection admission already consumed its input");
    }
    const result = consume();
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Message injection admission consumers must remain synchronous");
    }
    consumed = true;
    return result;
  };
  const admission = prepare && injectionAdmissions.get(prepare);
  if (!admission) {
    if (prepare) {
      await prepare();
    }
    return consumeSync();
  }
  try {
    const result = await admission(consumeSync);
    if (!consumed) {
      throw new Error("Message injection admission did not consume its input");
    }
    return result;
  } catch (cause) {
    if (consumed) {
      throw new MessageInjectionAcceptedUnconfirmedError({ cause });
    }
    throw cause;
  }
}

/** Order preparation on the captured backend; release before awaiting delivery. */
export function enqueueMessageInjection<T>(
  backend: object,
  run: (release: () => void) => Promise<T>,
): Promise<T> {
  let queue = injectionQueues.get(backend);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    injectionQueues.set(backend, queue);
  }
  const result = createDeferredCore<T>();
  void queue
    .enqueue(
      "input",
      () =>
        new Promise<void>((release) => {
          void run(release).then(result.resolve, result.reject).finally(release);
        }),
    )
    .catch(result.reject);
  return result.promise;
}

/** A refused owner assertion is terminal for this input, not permission to redispatch it. */
export class MessageInjectionAuthorityError extends Error {
  constructor(options?: ErrorOptions) {
    super("Message injection authority is no longer current", options);
    this.name = "MessageInjectionAuthorityError";
  }
}

/** The caller remains valid, but this target can no longer receive its input. */
export class MessageInjectionTargetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageInjectionTargetUnavailableError";
  }
}

/** The delivery owner removed the exact queued input before provider submission. */
export class MessageInjectionWithdrawnError extends MessageInjectionTargetUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "MessageInjectionWithdrawnError";
  }
}

/** Enqueued input retains custody even when admission cleanup or notification fails. */
export class MessageInjectionAcceptedUnconfirmedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Message injection was accepted but its completion is unconfirmed", options);
    this.name = "MessageInjectionAcceptedUnconfirmedError";
  }
}

/** One injection stays revoked even if its source later appears current again. */
export function createMessageInjectionAuthority(canInject: () => boolean): () => void {
  let revoked: MessageInjectionAuthorityError | undefined;
  return () => {
    if (!revoked) {
      try {
        if (canInject()) {
          return;
        }
      } catch (cause) {
        revoked = new MessageInjectionAuthorityError({ cause });
      }
      revoked ??= new MessageInjectionAuthorityError();
    }
    throw revoked;
  };
}
