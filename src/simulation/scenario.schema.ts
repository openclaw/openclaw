import { z } from "zod";

const scenarioAgentSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});

const scenarioChannelSchema = z.object({
  type: z.string().min(1),
  accounts: z.array(z.object({ id: z.string().min(1) })).min(1),
});

const scenarioConversationSchema = z.object({
  id: z.string().min(1),
  channel: z.string().min(1),
  account: z.string().min(1),
  peer: z.string().min(1),
  chatType: z.enum(["direct", "group"]),
});

const scenarioProviderModelSchema = z.object({
  latencyMs: z.number().int().nonnegative(),
  response: z.string(),
  errorRate: z.number().min(0).max(1).optional(),
});

const scenarioTrafficSchema = z.object({
  conversation: z.string().min(1),
  pattern: z.enum(["burst", "steady", "random", "replay"]),
  count: z.number().int().positive(),
  intervalMs: z.number().int().nonnegative(),
  startAtMs: z.number().int().nonnegative().default(0),
  senderIds: z.array(z.string().min(1)).min(1),
  replayFile: z.string().optional(),
  lambda: z.number().positive().optional(),
});

const scenarioMonitorSchema = z.object({
  sampleIntervalMs: z.number().int().positive().default(100),
  captureEvents: z.array(z.string()).optional(),
});

const symptomThresholdsSchema = z
  .object({
    reply_explosion: z
      .object({ maxRatio: z.number().positive(), windowMs: z.number().int().positive() })
      .optional(),
    lag_drift: z
      .object({
        maxSlopeMs: z.number().positive(),
        windowMessages: z.number().int().positive(),
      })
      .optional(),
    queue_backlog: z
      .object({
        maxDepth: z.number().int().positive(),
        sustainedGrowthSamples: z.number().int().positive(),
      })
      .optional(),
    stale_context: z.object({ maxStaleness: z.number().int().positive() }).optional(),
    out_of_sync: z.object({ enabled: z.boolean() }).optional(),
  })
  .optional();

const assertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("max_queue_depth"),
    lane: z.string(),
    threshold: z.number().int().positive(),
  }),
  z.object({ type: z.literal("max_reply_latency_ms"), threshold: z.number().positive() }),
  z.object({
    type: z.literal("no_reply_explosion"),
    maxRepliesPerMessage: z.number().int().positive(),
  }),
  z.object({ type: z.literal("no_stale_context"), maxStaleness: z.number().int().positive() }),
  z.object({
    type: z.literal("no_symptoms"),
    severity: z.enum(["warning", "critical"]).optional(),
  }),
]);

export const scenarioConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  seed: z.number().int().optional(),
  agents: z.array(scenarioAgentSchema).min(1),
  channels: z.array(scenarioChannelSchema).min(1),
  conversations: z.array(scenarioConversationSchema).min(1),
  providers: z.record(
    z.string(),
    z.object({ models: z.record(z.string(), scenarioProviderModelSchema) }),
  ),
  traffic: z.array(scenarioTrafficSchema).min(1),
  config: z
    .object({
      agents: z
        .object({
          defaults: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
  monitor: scenarioMonitorSchema.optional(),
  symptoms: symptomThresholdsSchema,
  assertions: z.array(assertionSchema).optional(),
});
