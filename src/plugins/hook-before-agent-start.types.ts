/** Attachment metadata exposed before model selection so plugins can route by modality. */
export type PluginHookBeforeModelResolveAttachment = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};

/** Early hook event for choosing a provider/model before session messages exist. */
export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
  /** Attachment metadata for file-aware model routing. */
  attachments?: PluginHookBeforeModelResolveAttachment[];
};

/** Provider/model override payload returned by before_model_resolve hooks. */
export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "local-provider" */
  providerOverride?: string;
};

/** Prompt-build hook event after session messages have been prepared. */
export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  /** Session messages prepared for this run. */
  messages: unknown[];
};

/** Prompt mutation payload merged into the system prompt/context for one run. */
export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  /**
   * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  appendSystemContext?: string;
};

/** Fields stripped from legacy before_agent_start when prompt mutation is disabled. */
export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
  "systemPrompt",
  "prependContext",
  "appendContext",
  "prependSystemContext",
  "appendSystemContext",
] as const satisfies readonly (keyof PluginHookBeforePromptBuildResult)[];

type MissingPluginPromptMutationResultFields = Exclude<
  keyof PluginHookBeforePromptBuildResult,
  (typeof PLUGIN_PROMPT_MUTATION_RESULT_FIELDS)[number]
>;
type AssertAllPluginPromptMutationResultFieldsListed =
  MissingPluginPromptMutationResultFields extends never ? true : never;
const assertAllPluginPromptMutationResultFieldsListed: AssertAllPluginPromptMutationResultFieldsListed = true;
void assertAllPluginPromptMutationResultFieldsListed;

/**
 * @deprecated Use before_model_resolve and before_prompt_build.
 *
 * Legacy compatibility hook that combines both phases.
 */
export type PluginHookBeforeAgentStartEvent = {
  prompt: string;
  runId?: string;
  /** Optional because legacy hook can run in pre-session phase. */
  messages?: unknown[];
};

/** @deprecated Use before_model_resolve and before_prompt_build result types. */
export type PluginHookBeforeAgentStartResult = PluginHookBeforePromptBuildResult &
  PluginHookBeforeModelResolveResult;

/** @deprecated Use before_model_resolve override result types. */
export type PluginHookBeforeAgentStartOverrideResult = Omit<
  PluginHookBeforeAgentStartResult,
  keyof PluginHookBeforePromptBuildResult
>;

/**
 * Keep legacy before_agent_start model/provider overrides while removing prompt
 * mutation fields that are governed by the newer prompt-build policy gate.
 */
export const stripPromptMutationFieldsFromLegacyHookResult = (
  result: PluginHookBeforeAgentStartResult | void,
): PluginHookBeforeAgentStartOverrideResult | void => {
  if (!result || typeof result !== "object") {
    return result;
  }
  const remaining: Partial<PluginHookBeforeAgentStartResult> = { ...result };
  for (const field of PLUGIN_PROMPT_MUTATION_RESULT_FIELDS) {
    delete remaining[field];
  }
  return Object.keys(remaining).length > 0
    ? (remaining as PluginHookBeforeAgentStartOverrideResult)
    : undefined;
};
