type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function compareKeys(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function canonicalizeJsonValue(value: unknown): CanonicalJson {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Policy JSON contains a non-finite number.");
    }
    return value;
  }
  if (typeof value === "string") {
    return value.normalize("NFC");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonValue(entry));
  }
  if (typeof value === "object") {
    const seen = new Set<string>();
    const entries = Object.entries(value as Record<string, unknown>)
      .map(
        ([key, entryValue]) => [key.normalize("NFC"), canonicalizeJsonValue(entryValue)] as const,
      )
      .toSorted(([a], [b]) => compareKeys(a, b));
    const out: Record<string, CanonicalJson> = {};
    for (const [key, entryValue] of entries) {
      if (seen.has(key)) {
        throw new Error(`Policy JSON contains duplicate key "${key}" after Unicode normalization.`);
      }
      seen.add(key);
      out[key] = entryValue;
    }
    return out;
  }
  throw new Error("Policy JSON contains an unsupported value type.");
}

export function canonicalizePolicyJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}
