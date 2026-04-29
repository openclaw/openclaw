export type SecurityGuardrailConfig = {
  /** Enable the security guardrail for outbound prompt sanitization. */
  enable?: boolean;
  /** OpenAI-compatible API base URL for the local sanitization model (e.g. http://localhost:1234/v1). */
  localBaseUrl?: string;
  /** API key for the local model endpoint (e.g. "lm-studio" for LM Studio). */
  localApiKey?: string;
  /** Model identifier to use for local sanitization (e.g. "qwen3-30b-a3b"). */
  localModel?: string;
  /**
   * Additional filtering instructions appended to the local model system prompt.
   * Use this to tell the local model about org-specific sensitive patterns
   * (e.g. project codenames, internal domain names).
   */
  customPrompt?: string;
  /** Fall back to regex-only scanning when the local model is unavailable. Default: true. */
  fallbackToRegexOnly?: boolean;
};
