import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
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
    const result = consume();
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
    return await admission(consumeSync);
  } catch (cause) {
    if (consumed) {
      throw new MessageInjectionAcceptedUnconfirmedError({ cause });
    }
    throw cause;
  }
}

/** Order preparation on the captured backend. */
export function enqueueMessageInjection<T>(backend: object, run: () => Promise<T>): Promise<T> {
  let queue = injectionQueues.get(backend);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    injectionQueues.set(backend, queue);
  }
  return queue.enqueue("input", run);
}

/** A refused owner assertion is terminal for this input, not permission to redispatch it. */
export class MessageInjectionAuthorityError extends Error {
  constructor(options?: ErrorOptions) {
    super("Message injection authority is no longer current", options);
    this.name = "MessageInjectionAuthorityError";
  }
}

/** The input belongs to another requester and may be admitted as a separate turn. */
export class MessageInjectionRequesterMismatchError extends Error {
  override name = "MessageInjectionRequesterMismatchError";

  constructor() {
    super("Steering requires the active turn's authenticated requester");
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
