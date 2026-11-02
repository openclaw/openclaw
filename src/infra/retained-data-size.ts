import { types } from "node:util";

/** Bounded plain-data estimate, never serialization, plugin execution, or a heap snapshot. */
export function estimateRetainedDataSize(roots: Iterable<unknown>): {
  approximateBytes: number;
  stringBytes: number;
  objects: number;
  truncated: boolean;
} {
  const seen = new WeakSet<object>();
  let remaining = 100_000;
  let approximateBytes = 0;
  let stringBytes = 0;
  let objects = 0;
  let truncated = false;
  const visit = (value: unknown, depth = 0): void => {
    if (--remaining < 0 || depth > 64) {
      remaining = -1;
      truncated = true;
      return;
    }
    if (typeof value === "string") {
      approximateBytes += value.length * 2;
      stringBytes += value.length * 2;
    } else if (typeof value === "number" || typeof value === "boolean") {
      approximateBytes += 8;
    } else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      objects++;
      approximateBytes += 16;
      // Proxies and custom instances can execute code during inspection. Only
      // plain records/arrays expose data descriptors without invoking their owner.
      if (types.isProxy(value)) {
        truncated = true;
        return;
      }
      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) {
        truncated = true;
        return;
      }
      for (const key in value) {
        if (--remaining < 0) {
          truncated = true;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor) {
          approximateBytes += (array ? 0 : key.length * 2) + 8;
          stringBytes += array ? 0 : key.length * 2;
          visit(descriptor.value, depth + 1);
        } else if (descriptor) {
          truncated = true;
        }
      }
    }
  };
  for (const root of roots) {
    visit(root);
    if (remaining < 0) {
      break;
    }
  }
  return { approximateBytes, stringBytes, objects, truncated };
}
