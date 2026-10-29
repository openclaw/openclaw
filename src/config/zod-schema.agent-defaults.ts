// Composes dependency-heavy runtime validators onto the leaf agent-defaults schema.
import { AgentDefaultsBaseSchema } from "./zod-schema.agent-defaults-base.js";
import { AgentContextLimitsSchema, AgentSandboxSchema } from "./zod-schema.agent-runtime.js";
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
  sandbox: AgentSandboxSchema,
})
  .strict()
  .optional();
