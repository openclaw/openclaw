/** JSON primitive values accepted across plugin host-hook boundaries. */
export type PluginJsonPrimitive = string | number | boolean | null;

/** JSON-like value that plugins may persist, return, or attach to host-hook payloads. */
export type PluginJsonValue =
  | PluginJsonPrimitive
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

/** Structural and serialized-size caps for plugin-provided JSON payloads. */
export type PluginJsonValueLimits = {
  maxDepth: number;
  maxNodes: number;
  maxObjectKeys: number;
  maxStringLength: number;
  maxSerializedBytes: number;
};

/** Shared guardrails for plugin JSON values before they enter persisted or RPC-visible state. */
export const PLUGIN_JSON_VALUE_LIMITS: PluginJsonValueLimits = {
  maxDepth: 32,
  maxNodes: 4096,
  maxObjectKeys: 512,
  maxStringLength: 64 * 1024,
  maxSerializedBytes: 256 * 1024,
};

function isPluginJsonValueWithinLimits(
  value: unknown,
  limits: PluginJsonValueLimits,
  state: { depth: number; nodes: number },
): value is PluginJsonValue {
  // `state` is shared through the traversal so maxNodes applies to the whole payload,
  // not independently to each branch.
  state.nodes += 1;
  if (state.nodes > limits.maxNodes || state.depth > limits.maxDepth) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") {
    return value.length <= limits.maxStringLength;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    state.depth += 1;
    const ok = value.every((entry) => isPluginJsonValueWithinLimits(entry, limits, state));
    state.depth -= 1;
    return ok;
  }
  if (typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  // Host-hook values cross process/storage boundaries as JSON; class instances and built-ins
  // would lose their behavior or serialize inconsistently, so only plain records are accepted.
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > limits.maxObjectKeys) {
    return false;
  }
  state.depth += 1;
  const ok = entries.every(
    ([key, entry]) =>
      key.length <= limits.maxStringLength && isPluginJsonValueWithinLimits(entry, limits, state),
  );
  state.depth -= 1;
  return ok;
}

/** Returns whether a value is safe to expose as plugin JSON across host-hook APIs. */
export function isPluginJsonValue(value: unknown): value is PluginJsonValue {
  if (!isPluginJsonValueWithinLimits(value, PLUGIN_JSON_VALUE_LIMITS, { depth: 0, nodes: 0 })) {
    return false;
  }
  try {
    return (
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
      PLUGIN_JSON_VALUE_LIMITS.maxSerializedBytes
    );
  } catch {
    return false;
  }
}
