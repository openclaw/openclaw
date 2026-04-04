export const PROMPT_MODES = ["full", "minimal", "none", "custom"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

export const PROMPT_SECTION_IDS = [
  "tooling",
  "toolCallStyle",
  "safety",
  "cli",
  "skills",
  "memory",
  "selfUpdate",
  "modelAliases",
  "workspace",
  "docs",
  "sandbox",
  "authorizedSenders",
  "currentDateTime",
  "workspaceFiles",
  "replyTags",
  "messaging",
  "voice",
  "extraContext",
  "reactions",
  "reasoningFormat",
  "projectContext",
  "silentReplies",
  "heartbeats",
  "runtime",
] as const;
export type PromptSectionId = (typeof PROMPT_SECTION_IDS)[number];

export type AgentSystemPromptConfig = {
  mode?: PromptMode;
  sections?: PromptSectionId[];
};

export function resolveEffectivePromptConfig(params: {
  baseMode: Exclude<PromptMode, "custom">;
  override?: AgentSystemPromptConfig;
}): {
  mode: PromptMode;
  sections?: PromptSectionId[];
} {
  if (!params.override) {
    return { mode: params.baseMode };
  }

  if (params.override.mode === "custom") {
    return params.baseMode === "full"
      ? {
          mode: "custom",
          sections: params.override.sections ?? [],
        }
      : { mode: params.baseMode };
  }

  if (params.override.mode) {
    return { mode: params.override.mode };
  }

  return { mode: params.baseMode };
}
