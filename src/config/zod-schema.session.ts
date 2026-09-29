// Defines session-related Zod schema fragments for config parsing.
import { z } from "zod";
import { ElevatedAllowFromSchema } from "./zod-schema.agent-runtime.js";
import { NativeCommandsSettingSchema } from "./zod-schema.messages.js";

export { MessagesSchema } from "./zod-schema.messages.js";
export { SessionSchema } from "./zod-schema.session-config.js";

export const CommandsSchema = z
  .object({
    native: NativeCommandsSettingSchema.optional().default("auto"),
    nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
    text: z.boolean().optional(),
    bash: z.boolean().optional(),
    bashForegroundMs: z.number().int().min(0).max(30_000).optional(),
    config: z.boolean().optional(),
    mcp: z.boolean().optional(),
    plugins: z.boolean().optional(),
    debug: z.boolean().optional(),
    restart: z.boolean().optional().default(true),
    ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    allowFrom: ElevatedAllowFromSchema.optional(),
  })
  .strict()
  .optional()
  .default(() => ({ native: "auto", nativeSkills: "auto", restart: true }) as const);
