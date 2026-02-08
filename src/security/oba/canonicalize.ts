/**
 * Deterministic canonical JSON serialization.
 * Sorted keys, no whitespace. Rejects non-JSON-safe values
 * (undefined, functions, symbols, BigInt) to keep signatures predictable.
 */
export function canonicalize(value: unknown): string {
  return serializeValue(value);
}

function serializeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    throw new CanonicalizeError("undefined is not valid JSON");
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalizeError(`non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    }
    case "bigint":
      throw new CanonicalizeError("BigInt is not valid JSON");
    case "string":
      return JSON.stringify(value);
    case "symbol":
      throw new CanonicalizeError("Symbol is not valid JSON");
    case "function":
      throw new CanonicalizeError("Function is not valid JSON");
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item) => {
          if (item === undefined) {
            return "null";
          }
          return serializeValue(item);
        });
        return `[${items.join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).toSorted();
      const pairs: string[] = [];
      for (const key of keys) {
        const v = obj[key];
        // Skip undefined values in objects (matches JSON.stringify behavior)
        if (v === undefined) {
          continue;
        }
        pairs.push(`${JSON.stringify(key)}:${serializeValue(v)}`);
      }
      return `{${pairs.join(",")}}`;
    }
    default:
      throw new CanonicalizeError(`unsupported type: ${typeof value}`);
  }
}

export class CanonicalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizeError";
  }
}

/**
 * Prepare the signing payload from a container object (plugin manifest or skill metadata).
 * Deep-clones, removes oba.sig (keeps owner/kid/alg to bind identity), canonicalizes.
 */
export function preparePayloadForSigning(container: Record<string, unknown>): Buffer {
  const clone = structuredClone(container);
  const oba = clone.oba;
  if (oba && typeof oba === "object" && !Array.isArray(oba)) {
    delete (oba as Record<string, unknown>).sig;
  }
  return Buffer.from(canonicalize(clone), "utf-8");
}
