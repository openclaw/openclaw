import { isProxy } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Keep only immutable payload roots across appends, not every retained descendant.
const ownedTranscriptRoots = new WeakSet<object>();

/** Preserve ordinary transcript objects while admitting their JSON storage shape. */
export function normalizeTranscriptJsonValue(value: unknown, key: string): unknown {
  const visited = new Set<object>();
  if (requiresNativeJson(value, visited)) {
    // SDK v2026.9.8 accepts arbitrary custom data. Finish its observable serialization
    // before changing any sibling that a getter or toJSON could inspect.
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Preserve native JSON/toJSON semantics.
    const projected: unknown = JSON.parse(JSON.stringify({ __proto__: null, [key]: value }));
    const normalized =
      isRecord(projected) && Object.hasOwn(projected, key) ? projected[key] : undefined;
    return normalizePlainJson(normalized, visited, false);
  }
  return normalizePlainJson(value, visited);
}

function requiresNativeJson(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" || typeof value === "function";
  }
  if (isProxy(value)) {
    return true;
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== (array ? Array.prototype : Object.prototype) ||
    "toJSON" in value ||
    ancestors.has(value)
  ) {
    return true;
  }
  ancestors.add(value);
  try {
    for (const member of Reflect.ownKeys(value)) {
      if (array && member === "length") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, member)!;
      if (
        typeof member !== "string" ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        (array && (!/^(0|[1-9]\d*)$/.test(member) || Number(member) >= value.length)) ||
        requiresNativeJson(descriptor.value, ancestors)
      ) {
        return true;
      }
    }
    if (array) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index) && index in value) {
          return true;
        }
      }
    }
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function normalizePlainJson(
  value: unknown,
  admitted: Set<object>,
  copyStrings = true,
  retainRoots = true,
): unknown {
  if (value === null || typeof value !== "object") {
    if (copyStrings && typeof value === "string") {
      // A small slice can otherwise pin an entire tool output. Preserve lone surrogates.
      return Buffer.from(value, "utf16le").toString("utf16le");
    }
    return typeof value === "number"
      ? Number.isFinite(value)
        ? value || 0
        : null
      : typeof value === "symbol"
        ? undefined
        : value;
  }
  if (ownedTranscriptRoots.has(value) || admitted.has(value)) {
    return value;
  }
  const array = Array.isArray(value);
  const keys = Object.keys(value);
  const mutable = Object.isExtensible(value);
  let normalized = value;
  const length = array ? value.length : keys.length;
  for (let index = 0; index < length; index++) {
    const member = array ? String(index) : keys[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(value, member);
    const current: unknown = descriptor?.value;
    const next = normalizePlainJson(current, admitted, copyStrings, false);
    const retained = array && next === undefined ? null : next;
    if (retained && typeof retained === "object") {
      Object.freeze(retained);
      admitted.add(retained);
      if (retainRoots) {
        ownedTranscriptRoots.add(retained);
      }
    }
    // Equal string contents do not imply equal backing-store ownership.
    if (
      !(copyStrings && typeof current === "string") &&
      Object.is(current, retained) &&
      (retained !== undefined || !descriptor)
    ) {
      continue;
    }
    if (
      normalized === value &&
      (!mutable || (descriptor && (!descriptor.configurable || !descriptor.writable)))
    ) {
      normalized = array ? value.slice() : { ...value };
    }
    if (retained === undefined) {
      Reflect.deleteProperty(normalized, member);
    } else {
      Object.defineProperty(normalized, member, {
        value: retained,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return normalized;
}
