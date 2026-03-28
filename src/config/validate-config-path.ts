import type { ConfigSchemaResponse } from "./schema.js";

type PathSegment = string;
type JsonSchemaNode = Record<string, unknown>;

type ConfigPathValidationResult = {
  valid: boolean;
  suggestions: string[];
};

function isSchemaObject(value: unknown): value is JsonSchemaNode {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIndexSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

function isObjectSchema(node: JsonSchemaNode): boolean {
  const type = node.type;
  return (
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    isSchemaObject(node.properties) ||
    node.additionalProperties !== undefined
  );
}

function isArraySchema(node: JsonSchemaNode): boolean {
  const type = node.type;
  return (
    type === "array" || (Array.isArray(type) && type.includes("array")) || node.items !== undefined
  );
}

function expandSchemaVariants(node: JsonSchemaNode): JsonSchemaNode[] {
  const variants = [node];
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const value = node[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const option of value) {
      if (isSchemaObject(option)) {
        variants.push(option);
      }
    }
  }
  return variants;
}

function schemaAllowsPath(node: JsonSchemaNode, path: PathSegment[], index = 0): boolean {
  if (index >= path.length) {
    return true;
  }

  for (const candidate of expandSchemaVariants(node)) {
    if (isArraySchema(candidate)) {
      const segment = path[index];
      if (!isIndexSegment(segment)) {
        continue;
      }
      const items = candidate.items;
      if (Array.isArray(items)) {
        const itemIndex = Number.parseInt(segment, 10);
        const itemSchema = items[itemIndex];
        if (isSchemaObject(itemSchema) && schemaAllowsPath(itemSchema, path, index + 1)) {
          return true;
        }
      } else if (isSchemaObject(items) && schemaAllowsPath(items, path, index + 1)) {
        return true;
      }
    }

    if (!isObjectSchema(candidate)) {
      continue;
    }

    const segment = path[index];
    const properties = isSchemaObject(candidate.properties)
      ? (candidate.properties as Record<string, unknown>)
      : undefined;
    const propertySchema = properties?.[segment];
    if (isSchemaObject(propertySchema) && schemaAllowsPath(propertySchema, path, index + 1)) {
      return true;
    }

    const additional = candidate.additionalProperties;
    if (additional === true) {
      return true;
    }
    if (isSchemaObject(additional) && schemaAllowsPath(additional, path, index + 1)) {
      return true;
    }
  }

  return false;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j += 1) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function normalizeHintPath(path: string): string {
  return path.replaceAll("[]", ".0").replaceAll(".*", ".example");
}

function displayHintPath(path: string): string {
  return path.replaceAll("[]", "[0]").replaceAll(".*", ".<id>");
}

function formatPathSegments(path: PathSegment[]): string {
  let out = "";
  for (const segment of path) {
    if (isIndexSegment(segment)) {
      out += `[${segment}]`;
      continue;
    }
    out += out ? `.${segment}` : segment;
  }
  return out;
}

function collectSuggestedPaths(path: PathSegment[], schemaInfo: ConfigSchemaResponse): string[] {
  const requested = path.join(".");
  const suggestions: string[] = [];

  if (path.length > 3 && path[0] === "agents" && path[1] === "defaults" && path[2] === "tools") {
    const toolRest = path.slice(3);
    const globalToolPath = ["tools", ...toolRest];
    if (schemaAllowsPath(schemaInfo.schema as JsonSchemaNode, globalToolPath)) {
      suggestions.push(globalToolPath.join("."));
    }
    const perAgentPath = ["agents", "list", "0", "tools", ...toolRest];
    if (schemaAllowsPath(schemaInfo.schema as JsonSchemaNode, perAgentPath)) {
      suggestions.push(formatPathSegments(perAgentPath));
    }
  }

  const ranked = Object.keys(schemaInfo.uiHints ?? {})
    .filter((candidate) => candidate.includes("."))
    .filter((candidate) => !candidate.includes("*"))
    .map((candidate) => ({
      candidate,
      display: displayHintPath(candidate),
      distance: editDistance(requested.toLowerCase(), normalizeHintPath(candidate).toLowerCase()),
    }))
    .toSorted((a, b) => a.distance - b.distance || a.display.localeCompare(b.display));

  for (const entry of ranked) {
    if (entry.distance > Math.max(4, Math.floor(requested.length / 3))) {
      continue;
    }
    if (!suggestions.includes(entry.display)) {
      suggestions.push(entry.display);
    }
    if (suggestions.length >= 2) {
      break;
    }
  }

  return suggestions;
}

export function validateConfigPath(
  path: PathSegment[],
  schemaInfo: ConfigSchemaResponse,
): ConfigPathValidationResult {
  return {
    valid: schemaAllowsPath(schemaInfo.schema as JsonSchemaNode, path),
    suggestions: collectSuggestedPaths(path, schemaInfo),
  };
}
