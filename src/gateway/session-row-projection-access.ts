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
      return projections.get(context)?.read()?.readCapabilityEntry(query);
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

export function requireSessionRowProjection(context?: { sessionRowProjectionOwner?: object }) {
  const projection = getSessionRowProjection(context);
  if (!projection) {
    throw new Error("Session projection is unavailable before Gateway startup completes");
  }
  return projection;
}
