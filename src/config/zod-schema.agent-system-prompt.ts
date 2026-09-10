import { z } from "zod";
import { MAX_AGENT_SYSTEM_PROMPT_SECTION_CHARS } from "./agent-system-prompt-sections.js";

const SectionContentSchema = z
  .string()
  .max(MAX_AGENT_SYSTEM_PROMPT_SECTION_CHARS)
  .refine((value) => value.trim().length > 0, "Section content must not be blank");

const AgentSystemPromptSectionOverrideSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z.object({ mode: z.literal("disable") }).strict(),
  z
    .object({
      mode: z.enum(["replace", "prepend", "append"]),
      content: SectionContentSchema,
    })
    .strict(),
]);

export const AgentSystemPromptConfigSchema = z
  .object({
    sections: z
      .object({
        interaction_style: AgentSystemPromptSectionOverrideSchema.optional(),
        tool_call_style: AgentSystemPromptSectionOverrideSchema.optional(),
        execution_bias: AgentSystemPromptSectionOverrideSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
