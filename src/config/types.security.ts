/**
 * Security configuration for OpenClaw.
 */
export type SecurityConfig = {
  /** Prompt injection scanning configuration. */
  promptInjection?: PromptInjectionConfig;
};

export type PromptInjectionAction = "block" | "warn" | "log";

export type PromptInjectionConfig = {
  /** Enable prompt injection scanning (default: false). */
  enabled?: boolean;
  /** Model to use for scoring (provider/model). Falls back to agents.defaults.model. */
  scanModel?: string;
  /** Action when injection is detected: block (redact), warn (include warning), or log (just log). Default: block. */
  action?: PromptInjectionAction;
  /** Log incidents to file for audit trail. */
  logIncidents?: boolean;
  /** Path to write incident logs (default: ~/.openclaw/security/prompt-injection.log). */
  logPath?: string;
};
