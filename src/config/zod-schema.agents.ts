import { z } from "zod";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
    subagent: z
      .object({
        promptHook: z
          .object({
            enabled: z.boolean().optional(),
            mode: z.enum(["prepend", "append", "wrap"]).optional(),
            prefixPath: z.string().optional(),
            suffixPath: z.string().optional(),
            maxBytes: z.number().int().positive().optional(),
            onMissing: z.enum(["warn", "disable"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const BindingsSchema = z
  .array(
    z
      .object({
        agentId: z.string(),
        comment: z.string().optional(),
        match: z
          .object({
            channel: z.string(),
            accountId: z.string().optional(),
            peer: z
              .object({
                kind: z.union([
                  z.literal("direct"),
                  z.literal("group"),
                  z.literal("channel"),
                  /** @deprecated Use `direct` instead. Kept for backward compatibility. */
                  z.literal("dm"),
                ]),
                id: z.string(),
              })
              .strict()
              .optional(),
            guildId: z.string().optional(),
            teamId: z.string().optional(),
            roles: z.array(z.string()).optional(),
          })
          .strict(),
      })
      .strict(),
  )
  .optional();

export const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

export const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();
