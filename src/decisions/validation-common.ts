import { isProxy } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const decisionJsonLimits = { maxBytes: 1_048_576, maxNodes: 20_000, maxDepth: 32 };

type JsonValidationOptions = {
  maxBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  rejectProxies?: boolean;
};

export function isPlainDecisionRecord(value: unknown): value is Record<string, unknown> {
  // The shared record guard accepts class instances; decision evidence must exclude them.
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function finiteJsonUnchecked(
  value: unknown,
  {
    maxBytes = decisionJsonLimits.maxBytes,
    maxNodes = decisionJsonLimits.maxNodes,
    maxDepth = decisionJsonLimits.maxDepth,
    rejectProxies = false,
  }: JsonValidationOptions,
): "valid" | "oversized" | "invalid" {
  let nodes = 0;
  let bytes = 0;
  let tooDeep = false;
  const ancestors = new Set<object>();
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > maxDepth) {
      tooDeep = true;
      return true;
    }
    if (++nodes > maxNodes) {
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
    if (array ? Object.getPrototypeOf(entry) !== Array.prototype : !isPlainDecisionRecord(entry)) {
      return false;
    }
    const keys = Reflect.ownKeys(entry);
    if (keys.length > maxNodes || (array && entry.length > maxNodes)) {
      nodes = maxNodes + 1;
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
      if (nodes > maxNodes || bytes > maxBytes) {
        break;
      }
    }
    ancestors.delete(entry);
    return true;
  };
  if (!visit(value, 0)) {
    return "invalid";
  }
  if (tooDeep || nodes > maxNodes || bytes > maxBytes) {
    return "oversized";
  }
  // Bound encoded escaping/structure as well as string payloads.
  return Buffer.byteLength(JSON.stringify(value)) > maxBytes ? "oversized" : "valid";
}

export function finiteJson(
  value: unknown,
  options: JsonValidationOptions = {},
): "valid" | "oversized" | "invalid" {
  try {
    return finiteJsonUnchecked(value, options);
  } catch {
    return "invalid";
  }
}

export function decisionEntry(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    Array.isArray(value) ||
    isPlainDecisionRecord(value)
  );
}
