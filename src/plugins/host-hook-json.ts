/** Bounded JSON value shape accepted from plugin hooks. */
export type PluginJsonValue =
  | string
  | number
  | boolean
  | null
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

const PLUGIN_JSON_VALUE_LIMITS = {
  maxDepth: 32,
  maxNodes: 4096,
  maxObjectKeys: 512,
  maxStringLength: 64 * 1024,
  maxSerializedBytes: 256 * 1024,
};

function isPluginJsonValueWithinLimits(
  value: unknown,
  state: { depth: number; nodes: number },
  maxValueStringLength: number,
): value is PluginJsonValue {
  const limits = PLUGIN_JSON_VALUE_LIMITS;
  state.nodes += 1;
  if (state.nodes > limits.maxNodes || state.depth > limits.maxDepth) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") {
    return value.length <= maxValueStringLength;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    state.depth += 1;
    const ok = value.every((entry) =>
      isPluginJsonValueWithinLimits(entry, state, maxValueStringLength),
    );
    state.depth -= 1;
    return ok;
  }
  if (typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length > limits.maxObjectKeys) {
    return false;
  }
  state.depth += 1;
  const ok = entries.every(
    ([key, entry]) =>
      key.length <= limits.maxStringLength &&
      isPluginJsonValueWithinLimits(entry, state, maxValueStringLength),
  );
  state.depth -= 1;
  return ok;
}

/** Validates that a plugin hook payload is finite, plain JSON under size limits. */
export function isPluginJsonValue(
  value: unknown,
  options?: { maxValueStringLength: number },
): value is PluginJsonValue {
  const maxValueStringLength =
    options?.maxValueStringLength ?? PLUGIN_JSON_VALUE_LIMITS.maxStringLength;
  if (!isPluginJsonValueWithinLimits(value, { depth: 0, nodes: 0 }, maxValueStringLength)) {
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
