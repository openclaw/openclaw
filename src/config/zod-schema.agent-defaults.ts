// Composes dependency-heavy runtime validators onto the leaf agent-defaults schema.
import { z } from "zod";
import { AgentDefaultsBaseSchema } from "./zod-schema.agent-defaults-base.js";
import {
  AgentContextLimitsSchema,
  AgentSandboxSchema,
  HeartbeatSchema,
} from "./zod-schema.agent-runtime.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  HumanDelaySchema,
  TypingModeSchema,
} from "./zod-schema.core.js";

export { SilentReplyPolicyConfigSchema } from "./zod-schema.agent-defaults-base.js";

export const AgentDefaultsSchema = AgentDefaultsBaseSchema.safeExtend({
  contextLimits: AgentContextLimitsSchema,
  blockStreamingChunk: BlockStreamingChunkSchema.optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  humanDelay: HumanDelaySchema.optional(),
  typingMode: TypingModeSchema.optional(),
  heartbeat: HeartbeatSchema.unwrap()
    .safeExtend({ agentId: z.string().trim().min(1).optional() })
    .optional(),
  sandbox: AgentSandboxSchema,
})
  .strict()
  .optional();
