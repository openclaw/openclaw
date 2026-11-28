import { z, type ZodTypeAny } from "zod";
import {
  parseJsonSchemaIssuePath,
  validateJsonSchemaValue,
} from "../../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";
import type {
  ChannelConfigRuntimeIssue,
  ChannelConfigSchema,
  ChannelConfigUiHint,
} from "./types.config.js";

function cloneRuntimeIssue(issue: unknown): ChannelConfigRuntimeIssue {
  // SAFETY: Only object properties are copied, and path is checked before reading its segments.
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

/** Build a channel config schema from JSON Schema with runtime validation/default support. */
export function buildJsonChannelConfigSchema(
  schema: JsonSchemaObject,
  options?: {
    cacheKey?: string;
    uiHints?: Record<string, ChannelConfigUiHint>;
    runtime?: ChannelConfigSchema["runtime"];
  },
): ChannelConfigSchema {
  return {
    schema,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: options?.runtime ?? {
      safeParse(value) {
        const result = validateJsonSchemaValue({
          schema,
          cacheKey: options?.cacheKey ?? "channel-config-schema:json",
          value,
          applyDefaults: true,
        });
        return result.ok
          ? { success: true, data: result.value }
          : {
              success: false,
              issues: result.errors.map((issue) => ({
                path: parseJsonSchemaIssuePath(issue.path),
                message: issue.message,
              })),
            };
      },
    },
  };
}

/** Build a channel config schema from Zod, exporting JSON Schema when available. */
export function buildChannelConfigSchema(
  schema: ZodTypeAny,
  options?: {
    uiHints?: Record<string, ChannelConfigUiHint>;
    /** Select input mode when transforms must expose accepted config values to editors. */
    jsonSchemaMode?: "input" | "output";
  },
): ChannelConfigSchema {
  // Plugin roots can contain newer SDK schemas; the host must own their conversion context.
  // Published Zod v3 plugins retain permissive JSON Schema with their own runtime parser.
  const jsonSchema: JsonSchemaObject =
    "_zod" in schema
      ? (z.toJSONSchema(schema, {
          target: "draft-07",
          ...(options?.jsonSchemaMode ? { io: options.jsonSchemaMode } : {}),
          unrepresentable: "any",
        }) as JsonSchemaObject) // SAFETY: The host converter returns a draft-07 schema object.
      : { type: "object", additionalProperties: true };
  return {
    schema: jsonSchema,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: {
      safeParse(value) {
        const result = schema.safeParse(value);
        return result.success
          ? { success: true, data: result.data }
          : { success: false, issues: result.error.issues.map(cloneRuntimeIssue) };
      },
    },
  };
}
