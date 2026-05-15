// Diagnostic helpers that suggest the closest valid key when a config write
// names a key that does not exist in the schema. Kept small and dependency
// free so the cost on every validation failure stays negligible.

export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a) {
    return b.length;
  }
  if (!b) {
    return a.length;
  }

  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return dp[b.length];
}

export function suggestClosestKey(
  unknownKey: string,
  candidates: readonly string[],
  options?: { maxDistance?: number },
): string | null {
  const threshold = options?.maxDistance ?? 2;
  if (!unknownKey || candidates.length === 0) {
    return null;
  }

  let best: { key: string; d: number } | null = null;
  const unknownLower = unknownKey.toLowerCase();

  for (const candidate of candidates) {
    if (candidate === unknownKey) {
      continue;
    }
    // Case-insensitive distance keeps the suggestion useful when the user
    // typed a wrong case (port vs Port). Tie break on the original cased
    // candidate so the suggestion stays canonical.
    const d = editDistance(unknownLower, candidate.toLowerCase());
    if (d > threshold) {
      continue;
    }
    if (!best || d < best.d || (d === best.d && candidate < best.key)) {
      best = { key: candidate, d };
    }
  }

  return best ? best.key : null;
}

type JsonSchemaNode = {
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  additionalProperties?: JsonSchemaNode | boolean;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  $ref?: string;
};

function isNumericSegment(segment: string | number): boolean {
  if (typeof segment === "number") {
    return true;
  }
  return /^\d+$/.test(segment);
}

function resolveDollarRef(root: JsonSchemaNode, node: JsonSchemaNode): JsonSchemaNode {
  let current = node;
  // Local refs only (`#/definitions/...` or `#/$defs/...`).
  const seen = new Set<string>();
  while (typeof current.$ref === "string" && current.$ref.startsWith("#/")) {
    if (seen.has(current.$ref)) {
      return current;
    }
    seen.add(current.$ref);
    const pathParts = current.$ref.slice(2).split("/");
    let target: unknown = root;
    for (const part of pathParts) {
      if (!target || typeof target !== "object") {
        return current;
      }
      target = (target as Record<string, unknown>)[part];
    }
    if (!target || typeof target !== "object") {
      return current;
    }
    current = target as JsonSchemaNode;
  }
  return current;
}

function descendIntoSegment(
  root: JsonSchemaNode,
  node: JsonSchemaNode,
  segment: string | number,
): JsonSchemaNode | null {
  const resolved = resolveDollarRef(root, node);
  if (isNumericSegment(segment)) {
    if (Array.isArray(resolved.items)) {
      return resolved.items[0] ?? null;
    }
    return resolved.items ?? null;
  }
  const properties = resolved.properties;
  const key = String(segment);
  if (properties && key in properties) {
    return properties[key] ?? null;
  }
  if (typeof resolved.additionalProperties === "object" && resolved.additionalProperties !== null) {
    return resolved.additionalProperties;
  }
  return null;
}

export function getKnownKeysAtSchemaPath(
  schemaRoot: JsonSchemaNode,
  pathSegments: readonly (string | number)[],
): readonly string[] {
  let node: JsonSchemaNode | null = schemaRoot;
  for (const segment of pathSegments) {
    if (!node) {
      return [];
    }
    node = descendIntoSegment(schemaRoot, node, segment);
  }
  if (!node) {
    return [];
  }
  const resolved = resolveDollarRef(schemaRoot, node);
  const properties = resolved.properties;
  return properties ? Object.keys(properties) : [];
}
