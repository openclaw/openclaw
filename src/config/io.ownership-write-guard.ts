import type { AgentBinding } from "./types.agents.js";

function bindingIdentity(binding: AgentBinding): string {
  // Preserve JSON's omission of optional undefined fields while sorting keys
  // so include-owned bindings compare structurally instead of by authored order.
  return JSON.stringify(binding, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).toSorted(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });
}

/** Refuses automatic binding appends when an include owns the bindings collection. */
export function assertAutomaticBindingsWriteAllowed(params: {
  bindingsIncludeOwned: boolean;
  ownershipPaths: readonly (readonly string[])[];
  sourceBindings: readonly AgentBinding[];
  nextBindings: readonly AgentBinding[];
}): void {
  if (
    !params.bindingsIncludeOwned ||
    !params.ownershipPaths.some((ownershipPath) => ownershipPath[0] === "bindings")
  ) {
    return;
  }
  const sourceBindingKeys = new Set(params.sourceBindings.map(bindingIdentity));
  const requiredBindings = params.nextBindings.filter(
    (binding) => !sourceBindingKeys.has(bindingIdentity(binding)),
  );
  if (requiredBindings.length === 0) {
    return;
  }
  const required = requiredBindings.map((binding) => JSON.stringify(binding)).join(", ");
  throw Object.assign(
    new Error(
      `Automatic agent ownership materialization cannot append to $include-owned bindings. Add ${required || "the required channel-wide binding"} to the bindings include, then retry.`,
    ),
    { code: "CONFIG_WRITE_REJECTED" },
  );
}
