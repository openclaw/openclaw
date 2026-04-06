import { z } from "zod";

const MessageRoutingRuleSchema = z.object({
  match: z.array(z.string()),
  model: z.string(),
});

const MessageRoutingConfigSchema = z.object({
  rules: z.array(MessageRoutingRuleSchema),
  default: z.string().optional(),
});

const AgentTaskModelConfigSchema = z.object({
  chat: z.string().optional(),
  systemPrompt: z.string().optional(),
  simpleCompletion: z.string().optional(),
  messageRouting: MessageRoutingConfigSchema.optional(),
});

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      tasks: AgentTaskModelConfigSchema.optional(),
    })
    .strict(),
]);
