// before_model_resolve hook
export type PluginHookBeforeModelResolveAttachment = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};

export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
  /** Attachment metadata for file-aware model routing. */
  attachments?: PluginHookBeforeModelResolveAttachment[];
};

export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "local-provider" */
  providerOverride?: string;
};

// before_prompt_build hook
export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  /** Session messages prepared for this run. */
  messages: unknown[];
};

export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  /**
   * Prepended to the agent system prompt in the cacheable prefix region so
   * providers (Anthropic `cache_control`, OpenAI auto prefix cache) can cache
   * it across turns. Use for STATIC plugin guidance whose bytes do not change
   * between turns.
   *
   * Do NOT pass per-turn volatile content through this field; varying bytes
   * here invalidate the prefix cache on every turn. For volatile system-level
   * content use `prependDynamicSystemContext` (routes below the cache
   * boundary) or `prependContext` (routes into the per-turn user message).
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt in the cacheable prefix region so
   * providers (Anthropic `cache_control`, OpenAI auto prefix cache) can cache
   * it across turns. Use for STATIC plugin guidance whose bytes do not change
   * between turns.
   *
   * Do NOT pass per-turn volatile content through this field; varying bytes
   * here invalidate the prefix cache on every turn. For volatile system-level
   * content use `appendDynamicSystemContext` (routes below the cache
   * boundary) or `appendContext` (routes into the per-turn user message).
   */
  appendSystemContext?: string;
  /**
   * Prepended to the agent system prompt BELOW the cache-boundary marker, in
   * the dynamic-suffix region. The bytes before the marker stay byte-stable
   * across turns even when this content varies, so the provider prefix cache
   * hits on turn 2+.
   *
   * Use for per-turn volatile content that semantically belongs in the system
   * prompt rather than the user message (e.g. runtime context, current
   * session state). For static guidance use `prependSystemContext`. For
   * volatile content that belongs in the user turn use `prependContext`.
   */
  prependDynamicSystemContext?: string;
  /**
   * Appended to the agent system prompt BELOW the cache-boundary marker, in
   * the dynamic-suffix region. The bytes before the marker stay byte-stable
   * across turns even when this content varies, so the provider prefix cache
   * hits on turn 2+.
   *
   * Use for per-turn volatile content that semantically belongs in the system
   * prompt rather than the user message (e.g. runtime context appendix). For
   * static guidance use `appendSystemContext`. For volatile content that
   * belongs in the user turn use `appendContext`.
   */
  appendDynamicSystemContext?: string;
};

export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
  "systemPrompt",
  "prependContext",
  "appendContext",
  "prependSystemContext",
  "appendSystemContext",
  "prependDynamicSystemContext",
  "appendDynamicSystemContext",
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
