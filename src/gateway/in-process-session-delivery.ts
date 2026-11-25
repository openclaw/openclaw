import type { ChatRef } from "../sessions/chat-ref.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Source tools and the built Gateway redeem the same host-owned parameter object.
// The binding is not a wire field and grants no additional caller authority.
const generations = resolveGlobalSingleton<WeakMap<object, ChatRef>>(
  Symbol.for("openclaw.inProcessSessionDeliveryGenerations"),
  () => new WeakMap(),
);

export function bindInProcessSessionDeliveryGeneration<T extends object>(
  params: T,
  generation: ChatRef | undefined,
): T {
  if (generation) {
    generations.set(params, Object.freeze({ ...generation }));
  }
  return params;
}

export function readInProcessSessionDeliveryGeneration(params: unknown): ChatRef | undefined {
  return typeof params === "object" && params !== null ? generations.get(params) : undefined;
}
