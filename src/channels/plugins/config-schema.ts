/**
 * Channel config schema helpers.
 *
 * Builds common zod/JSON schema shapes and parses runtime config issues for channel plugins.
 */
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { DmPolicySchema } from "../../config/zod-schema.core.js";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";
import { parseConfigPathArrayIndex } from "../../shared/path-array-index.js";
import type {
  ChannelConfigRuntimeIssue,
  ChannelConfigRuntimeParseResult,
  ChannelConfigSchema,
  ChannelConfigUiHint,
} from "./types.config.js";

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

type ExtendableZodObject = ZodTypeAny & {
  extend: (shape: Record<string, ZodTypeAny>) => ZodTypeAny;
};

/** Shared allowlist entry shape for channel sender/user ids. */
export const AllowFromEntrySchema = z.union([z.string(), z.number()]);
/** Optional allowlist array used by channel config schema builders. */
export const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();

/** Build the common nested DM config block used by channel account schemas. */
export function buildNestedDmConfigSchema(extraShape?: ZodRawShape) {
  const baseShape = {
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: AllowFromListSchema,
  };
  return z.object(extraShape ? { ...baseShape, ...extraShape } : baseShape).optional();
}

/** Add `accounts` catchall and `defaultAccount` fields to a channel account schema. */
export function buildCatchallMultiAccountChannelSchema<T extends ExtendableZodObject>(
  accountSchema: T,
): T {
  return accountSchema.extend({
    accounts: z.object({}).catchall(accountSchema).optional(),
    defaultAccount: z.string().optional(),
  }) as T;
}

type BuildChannelConfigSchemaOptions = {
  uiHints?: Record<string, ChannelConfigUiHint>;
};

type BuildJsonChannelConfigSchemaOptions = {
  cacheKey?: string;
  uiHints?: Record<string, ChannelConfigUiHint>;
  runtime?: ChannelConfigSchema["runtime"];
};

function cloneRuntimeIssue(issue: unknown): ChannelConfigRuntimeIssue {
  const record = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
  const path = Array.isArray(record.path)
    ? record.path.filter((segment): segment is string | number => {
        const kind = typeof segment;
        return kind === "string" || kind === "number";
      })
    : undefined;
  return {
    ...record,
    ...(path ? { path } : {}),
  };
}

function safeParseRuntimeSchema(
  schema: ZodTypeAny,
  value: unknown,
): ChannelConfigRuntimeParseResult {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => cloneRuntimeIssue(issue)),
  };
}

function toIssuePath(path: string): Array<string | number> {
  if (!path || path === "<root>") {
    return [];
  }
  return path.split(".").map((segment) => {
    return parseConfigPathArrayIndex(segment) ?? segment;
  });
}

function safeParseJsonSchema(
  schema: JsonSchemaObject,
  cacheKey: string,
  value: unknown,
): ChannelConfigRuntimeParseResult {
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value,
    applyDefaults: true,
  });
  if (result.ok) {
    return { success: true, data: result.value };
  }
  return {
    success: false,
    issues: result.errors.map((issue) => ({
      path: toIssuePath(issue.path),
      message: issue.message,
    })),
  };
}

/** Build a channel config schema from JSON Schema with runtime validation/default support. */
export function buildJsonChannelConfigSchema(
  schema: JsonSchemaObject,
  options?: BuildJsonChannelConfigSchemaOptions,
): ChannelConfigSchema {
  return {
    schema,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: options?.runtime ?? {
      safeParse: (value) =>
        safeParseJsonSchema(schema, options?.cacheKey ?? "channel-config-schema:json", value),
    },
  };
}

/** Build a channel config schema from Zod, exporting JSON Schema when available. */
export function buildChannelConfigSchema(
  schema: ZodTypeAny,
  options?: BuildChannelConfigSchemaOptions,
): ChannelConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  if (typeof schemaWithJson.toJSONSchema === "function") {
    const jsonSchema = schemaWithJson.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
    }) as JsonSchemaObject;
    return {
      schema: relaxDefaultedRequired(jsonSchema),
      ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
      runtime: {
        safeParse: (value) => safeParseRuntimeSchema(schema, value),
      },
    };
  }

  // Compatibility fallback for plugins built against Zod v3 schemas,
  // where `.toJSONSchema()` is unavailable.
  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: {
      safeParse: (value) => safeParseRuntimeSchema(schema, value),
    },
  };
}

/**
 * Drop defaulted properties from `required`.
 *
 * Zod v4's `toJSONSchema` marks `.optional().default(...)` and `.default(...)`
 * fields as `required` because the runtime parser always supplies a value.
 * Bundled channel config metadata generated this way then rejects user
 * configs that omit those keys (see Feishu #77116). The runtime parser still
 * applies the default, so the JSON Schema must mirror that contract: any
 * property with a `default` cannot be `required`.
 *
 * Recurses into nested object schemas so the same rule applies to account
 * configs, group policies, and similar per-channel shapes.
 */
function relaxDefaultedRequired(schema: JsonSchemaObject): JsonSchemaObject {
  return relaxDefaultedRequiredInPlace(structuredClone(schema));
}

function relaxDefaultedRequiredInPlace(schema: unknown): JsonSchemaObject {
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      if (entry && typeof entry === "object") {
        relaxDefaultedRequiredInPlace(entry);
      }
    }
    return schema as JsonSchemaObject;
  }
  if (!schema || typeof schema !== "object") {
    return schema as JsonSchemaObject;
  }
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.required) && node.required.length > 0 && isRecord(node.properties)) {
    const properties = node.properties as Record<string, unknown>;
    const relaxedRequired = (node.required as string[]).filter((name) => {
      const propertySchema = properties[name];
      if (!propertySchema || typeof propertySchema !== "object") {
        return true;
      }
      return !Object.hasOwn(propertySchema as Record<string, unknown>, "default");
    });
    if (relaxedRequired.length === 0) {
      delete node.required;
    } else {
      node.required = relaxedRequired;
    }
  }
  for (const keyword of ["properties", "$defs", "definitions", "patternProperties"] as const) {
    const value = node[keyword];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        if (entry && typeof entry === "object") {
          relaxDefaultedRequiredInPlace(entry);
        }
      }
    }
  }
  for (const keyword of [
    "additionalProperties",
    "items",
    "contains",
    "additionalItems",
    "unevaluatedItems",
    "unevaluatedProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ] as const) {
    const value = node[keyword];
    if (value && typeof value === "object") {
      relaxDefaultedRequiredInPlace(value);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    const value = node[keyword];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") {
          relaxDefaultedRequiredInPlace(entry);
        }
      }
    }
  }
  if (node.dependencies && typeof node.dependencies === "object") {
    for (const entry of Object.values(node.dependencies as Record<string, unknown>)) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        relaxDefaultedRequiredInPlace(entry);
      }
    }
  }
  if (node.dependentSchemas && typeof node.dependentSchemas === "object") {
    for (const entry of Object.values(node.dependentSchemas as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        relaxDefaultedRequiredInPlace(entry);
      }
    }
  }
  return node as JsonSchemaObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Return a channel config schema for channels that intentionally accept no config keys. */
export function emptyChannelConfigSchema(): ChannelConfigSchema {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    runtime: {
      safeParse(value) {
        if (value === undefined) {
          return { success: true, data: undefined };
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return {
            success: false,
            issues: [{ path: [], message: "expected config object" }],
          };
        }
        if (Object.keys(value as Record<string, unknown>).length > 0) {
          return {
            success: false,
            issues: [{ path: [], message: "config must be empty" }],
          };
        }
        return { success: true, data: value };
      },
    },
  };
}
