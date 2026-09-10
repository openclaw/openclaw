/** Operator-configurable core system-prompt sections. */
const AGENT_SYSTEM_PROMPT_SECTION_IDS = [
  "interaction_style",
  "tool_call_style",
  "execution_bias",
] as const;

export type AgentSystemPromptSectionId = (typeof AGENT_SYSTEM_PROMPT_SECTION_IDS)[number];

export type AgentSystemPromptSectionOverride =
  | { mode: "default" }
  | { mode: "disable" }
  | { mode: "replace" | "prepend" | "append"; content: string };

export type AgentSystemPromptSectionOverrides = Partial<
  Record<AgentSystemPromptSectionId, AgentSystemPromptSectionOverride>
>;

export type AgentSystemPromptConfig = {
  sections?: AgentSystemPromptSectionOverrides;
};

/** Bound each configured section so prompt customization cannot grow without limit. */
export const MAX_AGENT_SYSTEM_PROMPT_SECTION_CHARS = 20_000;
