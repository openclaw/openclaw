import type { AnyAgentTool } from "./tools/common.js";

/** JSON value shape accepted after schema serialization for runtime compatibility checks. */
export type RuntimeToolInputSchemaJson =
  | null
  | boolean
  | number
  | string
  | RuntimeToolInputSchemaJson[]
  | { [key: string]: RuntimeToolInputSchemaJson };

/** Serialized runtime tool schema plus compatibility violations found during projection. */
export type RuntimeToolInputSchemaProjection = {
  readonly schema: RuntimeToolInputSchemaJson;
  readonly violations: readonly string[];
};

/** Tool-level schema compatibility diagnostic for runtime/tool inventory filtering. */
export type RuntimeToolSchemaDiagnostic = {
  readonly toolName: string;
  readonly toolIndex: number;
  readonly violations: readonly string[];
};

/** Compatible tool list plus diagnostics for tools dropped from runtime use. */
export type RuntimeToolSchemaInspection<TTool extends Pick<AnyAgentTool, "name" | "parameters">> = {
  readonly tools: readonly TTool[];
  readonly diagnostics: readonly RuntimeToolSchemaDiagnostic[];
};

function isJsonValue(value: unknown): value is RuntimeToolInputSchemaJson {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return true;
    case "object":
      if (Array.isArray(value)) {
        return value.every(isJsonValue);
      }
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    default:
      return false;
  }
}

function isJsonObject(value: RuntimeToolInputSchemaJson): value is {
  [key: string]: RuntimeToolInputSchemaJson;
} {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeToolInputSchema(value: unknown, path: string): RuntimeToolInputSchemaProjection {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return {
      schema: {},
      violations: [`${path} is not JSON-serializable`],
    };
  }
  if (!text) {
    return {
      schema: {},
      violations: [`${path} is not JSON-serializable`],
    };
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isJsonValue(parsed)) {
    return {
      schema: {},
      violations: [`${path} is not a JSON value`],
    };
  }
  return {
    schema: parsed,
    violations: [],
  };
}

function findDynamicSchemaKeywordViolations(
  schema: RuntimeToolInputSchemaJson,
  path: string,
): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      findDynamicSchemaKeywordViolations(entry, `${path}[${index}]`),
    );
  }
  if (!isJsonObject(schema)) {
    return [];
  }
  const violations: string[] = [];
  for (const key of ["$dynamicRef", "$dynamicAnchor"] as const) {
    if (key in schema) {
      violations.push(`${path}.${key}`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    if (schemaMapKeywords.has(key) && isJsonObject(value)) {
      for (const [schemaName, childSchema] of Object.entries(value)) {
        violations.push(
          ...findDynamicSchemaKeywordViolations(childSchema, `${path}.${key}.${schemaName}`),
        );
      }
    } else {
      violations.push(...findDynamicSchemaKeywordViolations(value, `${path}.${key}`));
    }
  }
  return violations;
}

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

/** Serializes and validates a tool parameter schema against runtime-safe JSON Schema limits. */
export function projectRuntimeToolInputSchema(
  schema: unknown,
  path = "parameters",
): RuntimeToolInputSchemaProjection {
  const projection = serializeToolInputSchema(schema, path);
  const violations = [...projection.violations];
  if (!isJsonObject(projection.schema)) {
    violations.push(`${path} must be a JSON object schema`);
  } else if (projection.schema.type !== undefined && projection.schema.type !== "object") {
    violations.push(`${path}.type must be "object"`);
  }
  violations.push(...findDynamicSchemaKeywordViolations(projection.schema, path));
  return {
    schema: projection.schema,
    violations,
  };
}

/** Collects schema compatibility diagnostics for a tool list without dropping tools. */
export function inspectRuntimeToolInputSchemas(
  tools: readonly Pick<AnyAgentTool, "name" | "parameters">[],
): RuntimeToolSchemaDiagnostic[] {
  return tools.flatMap((tool, toolIndex) => {
    const toolName = tool.name || `tool[${toolIndex}]`;
    const projection = projectRuntimeToolInputSchema(tool.parameters, `${toolName}.parameters`);
    if (projection.violations.length === 0) {
      return [];
    }
    return [{ toolName, toolIndex, violations: projection.violations }];
  });
}

/** Drops tools with incompatible parameter schemas and returns diagnostics for the drop. */
export function filterRuntimeCompatibleTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  const diagnostics = inspectRuntimeToolInputSchemas(tools);
  if (diagnostics.length === 0) {
    return { tools, diagnostics };
  }
  const blockedIndexes = new Set(diagnostics.map((diagnostic) => diagnostic.toolIndex));
  return {
    tools: tools.filter((_tool, index) => !blockedIndexes.has(index)),
    diagnostics,
  };
}
