import type { ReplyPayload } from "../types.js";
import type {
  ReplyDispatchAfterDeliver,
  ReplyDispatchAfterDeliverOutcome,
  ReplyDispatchRuntimeInfo,
} from "./reply-dispatcher.types.js";

const deliveryCompletionByResult = new WeakMap<object, Promise<unknown>>();

/** Defers after-delivery observers until a channel-owned finalization settles. */
export function attachReplyDispatchDeliveryCompletion<T extends object>(
  result: T,
  completion: Promise<unknown>,
): T {
  // The shipped dispatcher surface makes after-delivery observers optional.
  // Keep a deferred channel failure observable without creating an unhandled rejection.
  void completion.catch(() => undefined);
  deliveryCompletionByResult.set(result, completion);
  return result;
}

async function resolveReplyDispatchAfterDeliverOutcome(
  outcome: ReplyDispatchAfterDeliverOutcome,
): Promise<ReplyDispatchAfterDeliverOutcome> {
  const owner = outcome.status === "delivered" ? outcome.result : outcome.error;
  if (!owner || (typeof owner !== "object" && typeof owner !== "function")) {
    return outcome;
  }
  const completion = deliveryCompletionByResult.get(owner);
  if (!completion) {
    return outcome;
  }
  try {
    const result = await completion;
    return outcome.status === "delivered"
      ? { status: "delivered", result: result ?? outcome.result }
      : outcome;
  } catch (error: unknown) {
    return { status: "failed", error };
  }
}

export function createReplyDispatchAfterDeliverObservers(
  onError: (err: unknown, info: ReplyDispatchRuntimeInfo) => void,
): {
  append: (observer: ReplyDispatchAfterDeliver) => void;
  notify: (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
    outcome: ReplyDispatchAfterDeliverOutcome,
  ) => void;
} {
  const observers: ReplyDispatchAfterDeliver[] = [];
  return {
    append: (observer) => observers.push(observer),
    notify: (payload, info, outcome) => {
      const resolvedOutcome = resolveReplyDispatchAfterDeliverOutcome(outcome);
      for (const observer of observers) {
        void Promise.resolve()
          .then(async () => observer(payload, info, await resolvedOutcome))
          .catch((err: unknown) => {
            onError(err, info);
          });
      }
    },
  };
}
