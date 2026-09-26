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
      // Projection selection also supports aliases; capability readers require an exact tuple.
      return target?.canonicalKey === query.key &&
        target.agentId === query.agentId &&
        target.storePath === query.storePath
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
