import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const injectionQueues = resolveGlobalSingleton(
  Symbol.for("openclaw.messageInjectionQueues"),
  () => new WeakMap<object, KeyedAsyncQueue>(),
);

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
