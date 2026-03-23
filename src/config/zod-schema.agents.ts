import { z } from "zod";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

const AgentRoutingAliasSchema = z
  .object({
    agentId: z.string(),
    aliases: z.array(z.string()).optional(),
    description: z.string().optional(),
    routingHints: z.array(z.string()).optional(),
  })
  .strict();

const AgentOrchestrationPolicySchema = z
  .object({
    defaultBehavior: z.literal("orchestrate").optional(),
    fallbackBehavior: z.literal("self-answer").optional(),
    directRoutingMode: z.union([z.literal("hint"), z.literal("force")]).optional(),
    allowMultiAgentDelegation: z.boolean().optional(),
    preserveUserVisibleSingleChat: z.boolean().optional(),
  })
  .strict();

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
    orchestration: z
      .object({
        routingAliases: z.array(AgentRoutingAliasSchema).optional(),
        policy: AgentOrchestrationPolicySchema.optional(),
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
