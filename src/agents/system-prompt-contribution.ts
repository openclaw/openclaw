import type { ContextFragment } from "./agent-context-fragment.js";

export type { ContextFragment } from "./agent-context-fragment.js";

export type ProviderSystemPromptSectionId =
  | "interaction_style"
  | "tool_call_style"
  | "execution_bias";

export type ProviderSystemPromptContribution = {
  /**
   * Cache-stable provider guidance inserted above the system-prompt cache boundary.
   *
   * Use this for static provider/model-family instructions that should preserve
   * KV cache reuse across turns.
   */
  stablePrefix?: string;
  /**
   * Provider guidance inserted below the cache boundary.
   *
   * Use this only for genuinely dynamic text that is expected to vary across
   * runs or sessions.
   */
  dynamicSuffix?: string;
  /**
   * Whole-section replacements for selected core prompt sections.
   *
   * Values should contain the complete rendered section, including any desired
   * heading such as `## Tool Call Style`.
   */
  sectionOverrides?: Partial<Record<ProviderSystemPromptSectionId, string>>;
  /**
   * Phase 9: optional source-tagged context fragments for this contribution.
   *
   * When present, callers may render these via `renderContextFragmentsSafe`
   * and include the result in `stablePrefix` or `dynamicSuffix`.  The field is
   * metadata-only from the perspective of `ProviderSystemPromptContribution`
   * itself — the existing prompt assembly pipeline does not read it directly,
   * so omitting it produces identical output to previous behaviour.
   *
   * Use this to carry provenance information alongside contributed text so
   * that higher-level prompt builders can selectively render or filter
   * fragments by `source` or `type` without re-parsing the rendered string.
   */
  contextFragments?: ContextFragment[];
};
