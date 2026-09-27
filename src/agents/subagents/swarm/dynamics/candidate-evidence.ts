import { createHash } from "node:crypto";

export type CandidateManifest = {
  version: 1;
  candidateDigest: string;
  sourceDigest: string;
  recipeDigest: string;
  policyDigest: string;
};

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function canonical(value: unknown, parents = new Set<object>()): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || parents.has(value)) {
    throw new Error("digest input must be finite, acyclic JSON data");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("digest input must contain only plain objects and arrays");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("digest input must not contain symbol keys");
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => canonical(item, parents)).join(",")}]`;
    }
    // SAFETY: the prototype check above proves value is a plain record.
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], parents)}`)
      .join(",")}}`;
  } finally {
    parents.delete(value);
  }
}

function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

/**
 * Bind the exact candidate bytes and the source/recipe/policy context that produced them.
 * This is an identity, not evidence that any verification ran.
 */
export function candidateIdentity(manifest: CandidateManifest): string {
  if (manifest.version !== 1) {
    throw new Error("unsupported candidate manifest version");
  }
  for (const key of ["candidateDigest", "sourceDigest", "recipeDigest", "policyDigest"] as const) {
    requireText(manifest[key], key);
  }
  return stableDigest({
    candidateDigest: manifest.candidateDigest,
    sourceDigest: manifest.sourceDigest,
    recipeDigest: manifest.recipeDigest,
    policyDigest: manifest.policyDigest,
    version: manifest.version,
  });
}
