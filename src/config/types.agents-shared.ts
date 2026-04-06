import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
  SandboxSshSettings,
} from "./types.sandbox.js";

export type MessageRoutingRule = {
  /** Keywords/phrases to match (case-insensitive, any match triggers this rule). */
  match: string[];
  /** Model to use when this rule matches (provider/model or alias). */
  model: string;
};

export type MessageRoutingConfig = {
  /** Ordered list of routing rules. First match wins. */
  rules: MessageRoutingRule[];
  /** Fallback model if no rule matches. Defaults to agent primary if omitted. */
  default?: string;
};

export type AgentTaskModelConfig = {
  /** Model used for normal chat / turn execution. */
  chat?: string;
  /** Model used when assembling or rendering the system prompt/runtime prompt context. */
  systemPrompt?: string;
  /** Model used for lightweight one-shot completions and helper flows. */
  simpleCompletion?: string;
  /** Keyword-based pre-turn routing: select a model based on message content. */
  messageRouting?: MessageRoutingConfig;
};

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
      /** Optional task-specific model overrides. */
      tasks?: AgentTaskModelConfig;
    };

export type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
  /** Sandbox runtime backend id. Default: "docker". */
  backend?: string;
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
  workspaceRoot?: string;
  /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings;
  /** SSH-specific sandbox settings. */
  ssh?: SandboxSshSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
