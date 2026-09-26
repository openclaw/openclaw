import { isProxy } from "node:util/types";

const MAX_BYTES = 1_048_576;
const MAX_NODES = 20_000;

export function record(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function finiteJsonUnchecked(
  value: unknown,
  maxBytes: number,
  rejectProxies: boolean,
): "valid" | "oversized" | "invalid" {
  let nodes = 0;
  let bytes = 0;
  let tooDeep = false;
  const ancestors = new Set<object>();
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 32) {
      tooDeep = true;
      return true;
    }
    if (++nodes > MAX_NODES) {
      return true;
    }
    if (entry === null || typeof entry === "boolean") {
      return true;
    }
    if (typeof entry === "number") {
      return Number.isFinite(entry);
    }
    if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry);
      return true;
    }
    if (typeof entry !== "object" || !entry || ancestors.has(entry)) {
      return false;
    }
    if (rejectProxies && isProxy(entry)) {
      return false;
    }
    const array = Array.isArray(entry);
    if (array ? Object.getPrototypeOf(entry) !== Array.prototype : !record(entry)) {
      return false;
    }
    const keys = Reflect.ownKeys(entry);
    if (keys.length > MAX_NODES || (array && entry.length > MAX_NODES)) {
      nodes = MAX_NODES + 1;
      return true;
    }
    if (keys.some((key) => typeof key !== "string")) {
      return false;
    }
    if (array && keys.length !== entry.length + 1) {
      return false;
    }
    if (array) {
      for (let index = 0; index < entry.length; index++) {
        if (!Object.hasOwn(entry, index)) {
          return false;
        }
      }
    }
    ancestors.add(entry);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
      if (array && key === "length") {
        continue;
      }
      // Hidden data would disappear from the admitted structured clone.
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return false;
      }
      const item: unknown = descriptor.value;
      bytes += Buffer.byteLength(key);
      if (!visit(item, depth + 1)) {
        return false;
      }
      if (nodes > MAX_NODES || bytes > maxBytes) {
        break;
      }
    }
    ancestors.delete(entry);
    return true;
  };
  if (!visit(value, 0)) {
    return "invalid";
  }
  if (tooDeep || nodes > MAX_NODES || bytes > maxBytes) {
    return "oversized";
  }
  // Bound encoded escaping/structure as well as string payloads.
  return Buffer.byteLength(JSON.stringify(value)) > maxBytes ? "oversized" : "valid";
}

export function finiteJson(
  value: unknown,
  maxBytes = MAX_BYTES,
  rejectProxies = false,
): "valid" | "oversized" | "invalid" {
  try {
    return finiteJsonUnchecked(value, maxBytes, rejectProxies);
  } catch {
    return "invalid";
  }
}

export function decisionEntry(value: unknown): boolean {
  return value === null || typeof value === "string" || Array.isArray(value) || record(value);
}
