import type { ZodTypeAny } from "zod";
import type { ChannelConfigSchema } from "./types.plugin.js";

export function buildChannelConfigSchema(schema: ZodTypeAny): ChannelConfigSchema {
  return {
    schema: schema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
    }) as Record<string, unknown>,
  };
}
