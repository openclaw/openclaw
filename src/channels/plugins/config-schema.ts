import type { ZodTypeAny } from "zod";
import type { ChannelConfigSchema } from "./types.plugin.js";

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

export function buildChannelConfigSchema(schema: ZodTypeAny): ChannelConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      schema: schemaWithJson.toJSONSchema({
        target: "draft-07",
        unrepresentable: "any",
      }) as Record<string, unknown>,
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
