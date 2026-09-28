import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SessionRowProjectionBinding } from "./session-row-projection-binding.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const projections = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionRowProjectionOwners"),
  () =>
    new WeakMap<
      object,
      {
        read: () => SessionRowProjection | undefined;
        binding: InstanceType<typeof SessionRowProjectionBinding>;
      }
    >(),
);

/** Context copies retain the original instance binding; the runtime owns disposal. */
export function bindSessionRowProjection<T extends object>(
  context: T,
  read: () => SessionRowProjection | undefined,
) {
  const binding =
    projections.get(context)?.binding ??
    new SessionRowProjectionBinding(context, (query) => {
      const target = projections.get(context)?.read()?.sharingTarget(query);
      // The projection owns store-locator mapping; session-key aliases still require an exact read.
      return target?.canonicalKey === query.key && target.agentId === query.agentId
        ? target.entry
        : undefined;
    });
  projections.set(context, { read, binding });
  return Object.assign(context, { sessionRowProjectionOwner: binding });
}

export function getSessionRowProjection(context?: { sessionRowProjectionOwner?: object }) {
  const binding = context?.sessionRowProjectionOwner;
  return binding instanceof SessionRowProjectionBinding
    ? projections.get(binding.owner)?.read()
    : undefined;
}
