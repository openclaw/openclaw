import type { AcpConfig } from "./types.acp.js";
import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type { ApprovalsConfig } from "./types.approvals.js";
import type { AuthConfig } from "./types.auth.js";
import type { DiagnosticsConfig, LoggingConfig, SessionConfig, WebConfig } from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { CliConfig } from "./types.cli.js";
import type { CronConfig } from "./types.cron.js";
import type {
  CanvasHostConfig,
  DiscoveryConfig,
  GatewayConfig,
  TalkConfig,
} from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type { MemoryConfig } from "./types.memory.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ModelsConfig } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SecretProviderConfig } from "./types.secrets.js";
import type { SkillsConfig } from "./types.skills.js";
import type { ToolsConfig } from "./types.tools.js";

export type OpenClawConfig = {
  meta?: {
    /** Last OpenClaw version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  auth?: AuthConfig;
  acp?: AcpConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  cli?: CliConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "beta", or "dev"). */
    channel?: "stable" | "beta" | "dev";
    /** Check for updates on gateway start (npm installs only). */
    checkOnStart?: boolean;
    /** Core auto-update policy for package installs. */
    auto?: {
      /** Enable background auto-update checks and apply logic. Default: false. */
      enabled?: boolean;
      /** Stable channel minimum delay before auto-apply. Default: 6. */
      stableDelayHours?: number;
      /** Additional stable-channel jitter window. Default: 12. */
      stableJitterHours?: number;
      /** Beta channel check cadence. Default: 1 hour. */
      betaCheckIntervalHours?: number;
    };
  };
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for OpenClaw UI chrome (hex). */
    seamColor?: string;
    assistant?: {
      /** Assistant display name for UI surfaces. */
      name?: string;
      /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
  };
  secrets?: SecretsConfig;
  skills?: SkillsConfig;
  plugins?: PluginsConfig;
  models?: ModelsConfig;
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  media?: {
    /** Preserve original uploaded filenames when storing inbound media. */
    preserveFilenames?: boolean;
    /** Optional retention window for persisted inbound media cleanup. */
    ttlHours?: number;
  };
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
  cron?: CronConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  memory?: MemoryConfig;
  security?: SecurityConfig;
};

export type SecretTier = "open" | "controlled" | "restricted";

export type SecretRegistryEntry = {
  name: string;
  tier: SecretTier;
  description?: string;
  ttl?: number;
  type?: string; // e.g., "api_key", "github_pat", "ssh_key"
  hint?: string; // Human-readable description for agent
  capabilities?: string[]; // What this secret can do (OAuth scopes, etc.)
};

export type SecretsConfig = {
  // Secret management properties (registry-based)
  /** Secret definitions with tier-based access control. */
  registry?: SecretRegistryEntry[];
  /** Directory for grant files. Defaults to {dataDir}/grants/. */
  grantsDir?: string;
  /** Keychain service name. Defaults to "openclaw-secrets". */
  keychainService?: string;
  /** Vault backend type. Defaults to "keychain". */
  backend?: "keychain" | "1password" | "bitwarden" | "vault";

  // Secret resolution properties (provider-based)
  providers?: Record<string, SecretProviderConfig>;
  defaults?: {
    env?: string;
    file?: string;
    exec?: string;
  };
  resolution?: {
    maxProviderConcurrency?: number;
    maxRefsPerProvider?: number;
    maxBatchBytes?: number;
  };
};

export type SecurityCredentialMode = "legacy" | "yolo" | "balanced" | "strict";

export type SecurityConfig = {
  credentials?: {
    /** Security mode for credential access. Default: "legacy". */
    mode?: SecurityCredentialMode;
    broker?: {
      /** Enable credential broker for tool execution interception. */
      enabled?: boolean;
      /** Tools to intercept for credential injection. */
      interceptTools?: string[];
      /** Per-tool credential allowlists. Keys are tool names, values are allowed secret names. */
      toolAllowedSecrets?: Record<string, string[]>;
    };
  };
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  /**
   * Config after $include resolution and ${ENV} substitution, but BEFORE runtime
   * defaults are applied. Use this for config set/unset operations to avoid
   * leaking runtime defaults into the written config file.
   */
  resolved: OpenClawConfig;
  valid: boolean;
  config: OpenClawConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
