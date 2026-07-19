import { isProxy } from "node:util/types";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";

type CanonicalJsonState = {
  ancestors: WeakSet<object>;
  depth: number;
  nodes: number;
};

function hasCanonicalJsonDescriptors(
  value: unknown,
  state: CanonicalJsonState = {
    ancestors: new WeakSet(),
    depth: 0,
    nodes: 0,
  },
): boolean {
  state.nodes += 1;
  if (state.nodes > 4096 || state.depth > 32) {
    return false;
  }
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (isProxy(value) || state.ancestors.has(value)) {
    return false;
  }
  state.ancestors.add(value);
  state.depth += 1;
  const finish = (result: boolean) => {
    state.depth -= 1;
    state.ancestors.delete(value);
    return result;
  };
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return finish(false);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      return finish(false);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return finish(false);
      }
      if (!hasCanonicalJsonDescriptors(descriptor.value, state)) {
        return finish(false);
      }
    }
    return finish(
      ownKeys.every(
        (key) =>
          key === "length" ||
          (typeof key === "string" && /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < value.length),
      ),
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return finish(false);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return finish(false);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return finish(false);
    }
    if (!hasCanonicalJsonDescriptors(descriptor.value, state)) {
      return finish(false);
    }
  }
  return finish(true);
}

/** Detach plain JSON without invoking accessors, proxy traps, or custom serialization. */
export function materializeAuthorizationJson<T>(value: T): T | undefined {
  try {
    if (!hasCanonicalJsonDescriptors(value) || !isPluginJsonValue(value)) {
      return undefined;
    }
    const cloned = structuredClone(value) as T & PluginJsonValue;
    return isPluginJsonValue(cloned) ? (cloned as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Materialize the object input that authorization approves and the tool executes. */
export function materializeAuthorizationToolInput(
  value: unknown,
): Record<string, PluginJsonValue> | undefined {
  const cloned = materializeAuthorizationJson(value);
  return cloned !== null && typeof cloned === "object" && !Array.isArray(cloned)
    ? (cloned as Record<string, PluginJsonValue>)
    : undefined;
}
