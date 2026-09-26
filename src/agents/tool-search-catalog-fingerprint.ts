import { isProxy } from "node:util/types";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

const MAX_FINGERPRINT_ENTRIES = 256;
const MAX_SNAPSHOT_WEIGHT = 64 * 1024;
const UNSUPPORTED_SNAPSHOT = Symbol("unsupported-fingerprint-snapshot");
const fingerprints = new Map<string, { snapshot: unknown; digest: string }>();
const untrustedSchemaIdentities = new WeakMap<object, number>();
let nextUntrustedSchemaIdentity = 1;

function fingerprintDataKeys(value: object): string[] | undefined {
  if (isProxy(value)) {
    return undefined;
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  const plainPrototype = array
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
  if (!plainPrototype) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    array &&
    (Object.getOwnPropertySymbols(value).length > 0 ||
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index)))
  ) {
    return undefined;
  }
  return keys;
}

function matchesFingerprintSnapshot(value: unknown, snapshot: unknown): boolean {
  if (Object.is(value, snapshot)) {
    return true;
  }
  if (!value || typeof value !== "object" || !snapshot || typeof snapshot !== "object") {
    return false;
  }
  const keys = fingerprintDataKeys(value);
  if (
    !keys ||
    Array.isArray(value) !== Array.isArray(snapshot) ||
    keys.length !== Object.keys(snapshot).length
  ) {
    return false;
  }
  return keys.every((key) => {
    const current = Object.getOwnPropertyDescriptor(value, key)!;
    const previous = Object.getOwnPropertyDescriptor(snapshot, key);
    return (
      "value" in current &&
      previous !== undefined &&
      matchesFingerprintSnapshot(current.value, previous.value)
    );
  });
}

function captureFingerprintSnapshot(
  value: unknown,
  budget: { remaining: number },
  depth = 0,
): unknown {
  budget.remaining -= 64 + (typeof value === "string" ? value.length * 2 : 0);
  if (budget.remaining < 0 || depth > 32) {
    return UNSUPPORTED_SNAPSHOT;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    return UNSUPPORTED_SNAPSHOT;
  }
  const keys = fingerprintDataKeys(value);
  if (!keys) {
    return UNSUPPORTED_SNAPSHOT;
  }
  const fields: [string, unknown][] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) {
      return UNSUPPORTED_SNAPSHOT;
    }
    budget.remaining -= key.length * 2;
    const child = captureFingerprintSnapshot(descriptor.value, budget, depth + 1);
    if (child === UNSUPPORTED_SNAPSHOT) {
      return UNSUPPORTED_SNAPSHOT;
    }
    fields.push([key, child]);
  }
  return Array.isArray(value) ? fields.map(([, child]) => child) : Object.fromEntries(fields);
}

export function catalogEntriesFingerprint(entries: readonly ToolSearchCatalogEntry[]): string {
  return entries
    .map((entry) => {
      const definition = [
        entry.id,
        entry.source,
        entry.sourceName ?? "",
        entry.mcp,
        entry.name,
        entry.label ?? "",
        entry.description,
        entry.directVisible === true,
        entry.source === "openclaw"
          ? entry.parameters
          : untrustedSchemaFingerprint(entry.parameters),
        entry.source === "openclaw"
          ? entry.outputSchema
          : untrustedSchemaFingerprint(entry.outputSchema),
      ];
      const cached = fingerprints.get(entry.id);
      // Compare with an owned copy, never retained mutable tool/schema identities.
      if (cached && matchesFingerprintSnapshot(definition, cached.snapshot)) {
        return cached.digest;
      }
      const snapshot = captureFingerprintSnapshot(definition, { remaining: MAX_SNAPSHOT_WEIGHT });
      const digest = sha256StableValue(
        snapshot === UNSUPPORTED_SNAPSHOT ? definition : snapshot,
      ).digest;
      fingerprints.delete(entry.id);
      if (snapshot !== UNSUPPORTED_SNAPSHOT) {
        if (fingerprints.size >= MAX_FINGERPRINT_ENTRIES) {
          fingerprints.delete(fingerprints.keys().next().value!);
        }
        fingerprints.set(entry.id, { snapshot, digest });
      }
      return digest;
    })
    .toSorted()
    .join("\n");
}

function untrustedSchemaFingerprint(schema: unknown): string {
  if (schema === null || typeof schema !== "object") {
    return stableStringify(schema);
  }
  // Remote/client schemas may be attacker-sized or lazy hostile objects. Identity
  // invalidates reuse when their owning runtime replaces them without traversing them.
  const existing = untrustedSchemaIdentities.get(schema);
  if (existing !== undefined) {
    return `object:${existing}`;
  }
  const next = nextUntrustedSchemaIdentity++;
  untrustedSchemaIdentities.set(schema, next);
  return `object:${next}`;
}
