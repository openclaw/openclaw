export type HookMappingMatch = {
  path?: string;
  source?: string;
};

export type HookMappingTransform = {
  module: string;
  export?: string;
};

export type HookMappingConfig = {
  id?: string;
  match?: HookMappingMatch;
  action?: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  /** DANGEROUS: Disable external content safety wrapping for this hook. */
  allowUnsafeExternalContent?: boolean;
  channel?:
    | "last"
    | "whatsapp"
    | "telegram"
    | "discord"
    | "googlechat"
    | "slack"
    | "signal"
    | "imessage"
    | "msteams";
  to?: string;
  /** Override model for this hook (provider/model or alias). */
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransform;
};

export type HooksGmailTailscaleMode = "off" | "serve" | "funnel";

export type HooksGmailConfig = {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  /** DANGEROUS: Disable external content safety wrapping for Gmail hooks. */
  allowUnsafeExternalContent?: boolean;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: HooksGmailTailscaleMode;
    path?: string;
    /** Optional tailscale serve/funnel target (port, host:port, or full URL). */
    target?: string;
  };
  /** Optional model override for Gmail hook processing (provider/model or alias). */
  model?: string;
  /** Optional thinking level override for Gmail hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};

export type InternalHookHandlerConfig = {
  /** Event key to listen for (e.g., 'command:new', 'session:start') */
  event: string;
  /** Path to handler module (absolute or relative to cwd) */
  module: string;
  /** Export name from module (default: 'default') */
  export?: string;
};

export type HookConfig = {
  enabled?: boolean;
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type HookInstallRecord = {
  source: "npm" | "archive" | "path";
  spec?: string;
  sourcePath?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  hooks?: string[];
};

export type InternalHooksConfig = {
  /** Enable hooks system */
  enabled?: boolean;
  /** Legacy: List of internal hook handlers to register (still supported) */
  handlers?: InternalHookHandlerConfig[];
  /** Per-hook configuration overrides */
  entries?: Record<string, HookConfig>;
  /** Load configuration */
  load?: {
    /** Additional hook directories to scan */
    extraDirs?: string[];
  };
  /** Install records for hook packs or hooks */
  installs?: Record<string, HookInstallRecord>;
};

// ============================================================================
// Claude Code-style agent-level hooks configuration
// ============================================================================

/**
 * Agent-level hook event names (Claude Code-style).
 * These are triggered at specific points in the agent processing pipeline.
 */
export type AgentHookEventName =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "PreCompact";

/**
 * Single shell command hook definition.
 * Executes a shell command, passing JSON input to stdin.
 */
export type ShellHookCommand = {
  /** Hook type - always 'command' for shell commands */
  type: "command";
  /** Shell command to execute */
  command: string;
};

/**
 * Hook matcher configuration.
 * Determines when a hook should fire based on tool name or other criteria.
 */
export type AgentHookMatcher = {
  /** Regex or glob pattern to match tool names (for PreToolUse/PostToolUse) */
  toolPattern?: string;
  /** Exact tool names to match */
  toolNames?: string[];
};

/**
 * Single agent hook entry with matcher and hooks.
 */
export type AgentHookEntry = {
  /** Optional matcher to filter when this hook fires */
  matcher?: AgentHookMatcher | string;
  /** Array of hook commands to execute */
  hooks: ShellHookCommand[];
  /** Timeout in milliseconds for each command (default: 30000) */
  timeoutMs?: number;
  /** Working directory for command execution */
  cwd?: string;
};

/**
 * Claude Code-style hooks configuration.
 * Maps event names to arrays of hook entries.
 *
 * @example
 * ```json
 * {
 *   "agentHooks": {
 *     "UserPromptSubmit": [
 *       {
 *         "matcher": "",
 *         "hooks": [{ "type": "command", "command": "cat SOUL.md" }]
 *       }
 *     ],
 *     "PreToolUse": [
 *       {
 *         "matcher": { "toolPattern": "Bash.*" },
 *         "hooks": [{ "type": "command", "command": "echo 'Running bash'" }]
 *       }
 *     ]
 *   }
 * }
 * ```
 */
export type AgentHooksConfig = {
  /** Enable agent-level hooks (default: true if entries exist) */
  enabled?: boolean;
  /** Hook entries by event name */
  UserPromptSubmit?: AgentHookEntry[];
  PreToolUse?: AgentHookEntry[];
  PostToolUse?: AgentHookEntry[];
  Stop?: AgentHookEntry[];
  PreCompact?: AgentHookEntry[];
};

export type HooksConfig = {
  enabled?: boolean;
  path?: string;
  token?: string;
  maxBodyBytes?: number;
  presets?: string[];
  transformsDir?: string;
  mappings?: HookMappingConfig[];
  gmail?: HooksGmailConfig;
  /** Internal agent event hooks */
  internal?: InternalHooksConfig;
  /** Claude Code-style agent-level hooks */
  agentHooks?: AgentHooksConfig;
};
