import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";

/** Validation config for adaptive model routing. */
export type AdaptiveRoutingValidationConfig = {
  /** Validation mode: "heuristic" (default) or "llm". */
  mode?: "heuristic" | "llm";
  /** Minimum score [0..1] required to pass. Default: 0.75. */
  minScore?: number;
  /** Model used when mode="llm". Required if mode="llm". */
  validatorModel?: string;
  /** Max chars per tool output for validator input. Default: 2000. */
  maxToolOutputChars?: number;
  /** Max chars of assistant output for validator input. Default: 4000. */
  maxAssistantChars?: number;
  /** Redact common secret patterns in validator input. Default: true. */
  redactSecrets?: boolean;
};

/** Adaptive Model Routing config: run a local/cheap model first, validate, escalate to cloud if needed. */
export type AdaptiveRoutingConfig = {
  /** Enable adaptive routing. Default: false. */
  enabled?: boolean;
  /** Local/cheap model to try first (provider/model). Required when enabled. */
  localFirstModel?: string;
  /** Cloud model to escalate to on validation failure (provider/model). Required when enabled. */
  cloudEscalationModel?: string;
  /** Max escalations allowed. Capped at 1 for v1. Default: 1. */
  maxEscalations?: number;
  /** Skip adaptive routing when an explicit per-run model override is present. Default: true. */
  bypassOnExplicitOverride?: boolean;
  /** Include a redacted summary of the local attempt in the escalation prompt (internal metadata only). Default: false. */
  includeLocalAttemptSummary?: boolean;
  /**
   * When true, the local trial run uses a temporary session file and all
   * user-visible callbacks are suppressed. However, tool calls that mutate
   * external state (sending messages, writing files, executing commands) are
   * **not** rolled back if the trial fails and cloud escalation fires.
   *
   * v1 limitation: set this to true to bypass the local trial entirely when
   * agents routinely invoke mutating tools. A future version may support
   * tool-level read-only gating or speculative execution.
   */
  localTrialReadOnly?: boolean;
  /** Outcome validation settings. */
  validation?: AdaptiveRoutingValidationConfig;
};

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
      /** Outcome-aware escalation: run a local model first, validate, escalate to cloud on failure. Default: disabled. */
      adaptiveRouting?: AdaptiveRoutingConfig;
    };

export type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
  /** Agent workspace access inside the sandbox. */
  workspaceAccess?: "none" | "ro" | "rw";
  /**
   * Session tools visibility for sandboxed sessions.
   * - "spawned": only allow session tools to target sessions spawned from this session (default)
   * - "all": allow session tools to target any session
   */
  sessionToolsVisibility?: "spawned" | "all";
  /** Container/workspace scope for sandbox isolation. */
  scope?: "session" | "agent" | "shared";
  /** Legacy alias for scope ("session" when true, "shared" when false). */
  perSession?: boolean;
  workspaceRoot?: string;
  /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
