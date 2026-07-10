/** JSON primitive values accepted across plugin host-hook boundaries. */
export type PluginJsonPrimitive = string | number | boolean | null;

/** Bounded JSON value shape accepted from plugin hooks. */
export type PluginJsonValue =
  | PluginJsonPrimitive
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

/** Resource limits for untrusted plugin JSON payload validation. */
export type PluginJsonValueLimits = {
  maxDepth: number;
  maxNodes: number;
  maxObjectKeys: number;
  maxStringLength: number;
  maxSerializedBytes: number;
};

/** Default safety limits for plugin JSON hook payloads. */
const PLUGIN_JSON_VALUE_LIMITS: PluginJsonValueLimits = {
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
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return false;
    }
    if (value.length > limits.maxNodes - state.nodes) {
      return false;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, String(index))) {
        return false;
      }
    }
    state.depth += 1;
    let ok = true;
    for (const entry of value) {
      if (!isPluginJsonValueWithinLimits(entry, limits, state)) {
        ok = false;
        break;
      }
    }
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
  if (
    Object.getOwnPropertySymbols(value).some(
      (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
    )
  ) {
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

type PluginJsonContainerShapeState = {
  nodes: number;
  seen: WeakSet<object>;
};

function hasPluginJsonContainerShapeWithinLimits(
  value: unknown,
  depth: number,
  state: PluginJsonContainerShapeState,
): boolean {
  state.nodes += 1;
  if (
    state.nodes > PLUGIN_JSON_VALUE_LIMITS.maxNodes ||
    depth > PLUGIN_JSON_VALUE_LIMITS.maxDepth
  ) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") {
    return value.length <= PLUGIN_JSON_VALUE_LIMITS.maxStringLength;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (state.seen.has(value)) {
    return true;
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return false;
      }
      if (value.length > PLUGIN_JSON_VALUE_LIMITS.maxNodes - state.nodes) {
        return false;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          return false;
        }
        if (!("value" in descriptor)) {
          return false;
        }
        if (!hasPluginJsonContainerShapeWithinLimits(descriptor.value, depth + 1, state)) {
          return false;
        }
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    let enumerableStringKeys = 0;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) {
        continue;
      }
      if (typeof key === "symbol") {
        return false;
      }
      enumerableStringKeys += 1;
      if (
        enumerableStringKeys > PLUGIN_JSON_VALUE_LIMITS.maxObjectKeys ||
        key.length > PLUGIN_JSON_VALUE_LIMITS.maxStringLength
      ) {
        return false;
      }
      if (
        !("value" in descriptor) ||
        !hasPluginJsonContainerShapeWithinLimits(descriptor.value, depth + 1, state)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks bounded container shapes without invoking accessors. The runner uses
 * this before cloning so hostile graphs fail before clone allocation.
 */
export function hasPluginJsonContainerShape(value: unknown): boolean {
  return hasPluginJsonContainerShapeWithinLimits(value, 0, {
    nodes: 0,
    seen: new WeakSet<object>(),
  });
}

/** Validates that a plugin hook payload is finite, plain JSON under size limits. */
export function isPluginJsonValue(value: unknown): value is PluginJsonValue {
  try {
    if (!isPluginJsonValueWithinLimits(value, PLUGIN_JSON_VALUE_LIMITS, { depth: 0, nodes: 0 })) {
      return false;
    }
    return (
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
      PLUGIN_JSON_VALUE_LIMITS.maxSerializedBytes
    );
  } catch {
    return false;
  }
}
