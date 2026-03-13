import { z, type ZodTypeAny } from "zod";
import { DmPolicySchema } from "../../config/zod-schema.core.js";
import type { ChannelConfigSchema } from "./types.plugin.js";

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

type ExtendableZodObject = ZodTypeAny & {
  extend: (shape: Record<string, ZodTypeAny>) => ZodTypeAny;
};

type JsonSchemaNode = Record<string, unknown>;

export const AllowFromEntrySchema = z.union([z.string(), z.number()]);
export const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();

export function buildNestedDmConfigSchema() {
  return z
    .object({
      enabled: z.boolean().optional(),
      policy: DmPolicySchema.optional(),
      allowFrom: AllowFromListSchema,
    })
    .optional();
}

export function buildCatchallMultiAccountChannelSchema<T extends ExtendableZodObject>(
  accountSchema: T,
): T {
  return accountSchema.extend({
    accounts: z.object({}).catchall(accountSchema).optional(),
    defaultAccount: z.string().optional(),
  }) as T;
}

function isJsonSchemaNode(value: unknown): value is JsonSchemaNode {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGeneratedJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeGeneratedJsonSchema(entry));
  }
  if (!isJsonSchemaNode(value)) {
    return value;
  }

  const next: JsonSchemaNode = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeGeneratedJsonSchema(child)]),
  );

  const properties = isJsonSchemaNode(next.properties) ? next.properties : null;
  const required = Array.isArray(next.required)
    ? next.required.filter((key): key is string => typeof key === "string")
    : null;
  if (properties && required) {
    const filtered = required.filter((key) => {
      const propertySchema = properties[key];
      return !(isJsonSchemaNode(propertySchema) && Object.hasOwn(propertySchema, "default"));
    });
    if (filtered.length > 0) {
      next.required = filtered;
    } else {
      delete next.required;
    }
  }

  return next;
}

export function buildChannelConfigSchema(schema: ZodTypeAny): ChannelConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      schema: normalizeGeneratedJsonSchema(
        schemaWithJson.toJSONSchema({
          target: "draft-07",
          unrepresentable: "any",
        }),
      ) as Record<string, unknown>,
      ...(typeof schema.safeParse === "function"
        ? { safeParse: schema.safeParse.bind(schema) }
        : {}),
    };
  }

  // Compatibility fallback for plugins built against Zod v3 schemas,
  // where `.toJSONSchema()` is unavailable.
  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
  };
}
