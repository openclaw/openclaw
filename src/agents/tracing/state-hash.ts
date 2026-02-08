/**
 * Deterministic state hashing for agent tracing.
 *
 * Provides stable SHA-256 hashing of agent state for inspection and verification
 * that state changes as expected during execution.
 *
 * Hashing strategy:
 * - Only hash logical state (not timestamps, object IDs, or memory addresses)
 * - Sort object keys deterministically
 * - Use JSON serialization as the canonical form
 * - Fail loudly on unsupported types
 */

import crypto from "node:crypto";

/**
 * Canonicalize any value into a deterministic string for hashing.
 * Recursively processes objects, arrays, and primitives in a stable order.
 * Detects cycles and rejects unsupported builtin types.
 */
function canonicalize(value: unknown, visited?: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  const type = typeof value;

  switch (type) {
    case "boolean":
      return String(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`Cannot hash non-finite number: ${value}`);
      }
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      // Initialize visited set on first call
      if (!visited) {
        visited = new WeakSet();
      }

      // Detect cycles: throw on re-encountered objects
      if (visited.has(value as object)) {
        throw new Error("Cannot hash cyclic object reference");
      }

      // Reject unsupported builtin types
      if (value instanceof Date || value instanceof RegExp || value instanceof Error) {
        throw new Error(
          `Cannot hash unsupported type: ${(value as any).constructor?.name || typeof value}`,
        );
      }
      if (value instanceof Map || value instanceof Set) {
        throw new Error(
          `Cannot hash unsupported type: ${(value as any).constructor?.name || typeof value}`,
        );
      }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        throw new Error(
          `Cannot hash unsupported type: ${(value as any).constructor?.name || typeof value}`,
        );
      }

      if (Array.isArray(value)) {
        // Arrays: preserve order, hash each element
        visited.add(value);
        try {
          const elements = value.map((v) => canonicalize(v, visited));
          return `[${elements.join(",")}]`;
        } finally {
          visited.delete(value);
        }
      }

      // Plain objects: sort keys for determinism
      visited.add(value as object);
      try {
        const keys = Object.keys(value).sort();
        const pairs = keys.map((key) => {
          const v = (value as Record<string, unknown>)[key];
          // Skip undefined values (they don't serialize in JSON anyway)
          if (v === undefined) {
            return null;
          }
          const canonical = canonicalize(v, visited);
          return `${JSON.stringify(key)}:${canonical}`;
        });
        const filtered = pairs.filter((p) => p !== null) as string[];
        return `{${filtered.join(",")}}`;
      } finally {
        visited.delete(value as object);
      }
    }
    case "symbol":
    case "function":
      throw new Error(`Cannot hash value of type ${type}`);
    default:
      // Should be unreachable, but be defensive
      throw new Error(`Unknown type: ${type}`);
  }
}

/**
 * Compute a stable SHA-256 hash of agent state.
 *
 * @param state Logical state object to hash
 * @returns Hex-encoded SHA-256 hash
 * @throws If state contains unhashable types (functions, symbols, non-finite numbers)
 */
export function hashAgentState(state: unknown): string {
  const canonical = canonicalize(state);
  return crypto.createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * Create a test helper that hashes and returns the digest.
 * Useful for snapshots and state verification.
 */
export function hashAndDescribe(state: unknown): { hash: string; canonical: string } {
  const canonical = canonicalize(state);
  const hash = crypto.createHash("sha256").update(canonical, "utf-8").digest("hex");
  return { hash, canonical };
}
