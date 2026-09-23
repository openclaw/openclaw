import type { SessionRowProjection } from "./session-row-projection.js";

const projections = new WeakMap<object, () => SessionRowProjection | undefined>();

/** Context copies retain the original instance binding; the runtime owns disposal. */
export function bindSessionRowProjection<T extends object>(
  context: T,
  read: () => SessionRowProjection | undefined,
) {
  projections.set(context, read);
  return Object.assign(context, { sessionRowProjectionOwner: context });
}

export function getSessionRowProjection(context?: { sessionRowProjectionOwner?: object }) {
  const owner = context?.sessionRowProjectionOwner;
  return owner ? projections.get(owner)?.() : undefined;
}
