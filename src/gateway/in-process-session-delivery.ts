import type { SessionDeliveryGeneration } from "../config/sessions/session-delivery-generation.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Source tools and the built Gateway redeem the same host-owned parameter object.
// The binding is not a wire field and grants no additional caller authority.
const generations = resolveGlobalSingleton<WeakMap<object, SessionDeliveryGeneration>>(
  Symbol.for("openclaw.inProcessSessionDeliveryGenerations"),
  () => new WeakMap(),
);

export function bindInProcessSessionDeliveryGeneration<T extends object>(
  params: T,
  generation: SessionDeliveryGeneration | undefined,
): T {
  if (generation) {
    generations.set(params, Object.freeze({ ...generation }));
  }
  return params;
}

export function readInProcessSessionDeliveryGeneration(
  params: unknown,
): SessionDeliveryGeneration | undefined {
  return typeof params === "object" && params !== null ? generations.get(params) : undefined;
}
