import type { z } from "zod";
import type { TranscriptsConfig } from "../transcripts/config.js";
import type { ConfigIncludeOwnership } from "./includes.js";
import type { AcpConfig } from "./types.acp.js";
import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type { AuditConfig } from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { CronConfig } from "./types.cron.js";
import type { GatewayConfig } from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type { McpConfig } from "./types.mcp.js";
import type { MemoryConfig } from "./types.memory.js";
import type { BroadcastConfig, CommandsConfig, MessagesConfig } from "./types.messages.js";
import type { ModelsConfig, ModelsConfigInput } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SkillsConfig } from "./types.skills.js";
import type { ToolsConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";
import type { ProxyConfig } from "./zod-schema.proxy.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";
import type { SecuritySchema } from "./zod-schema.root-support.js";

/** One persisted suppression for a known security audit finding. */
export type SecurityConfig = NonNullable<z.input<typeof SecuritySchema>>;
export type SecurityAuditSuppression = NonNullable<
  NonNullable<SecurityConfig["audit"]>["suppressions"]
>[number];

export type SurfaceConfigEntry = NonNullable<z.input<typeof OpenClawSchemaShape.surfaces>>[string];

type SchemaConfig = {
  [K in keyof typeof OpenClawSchemaShape]?: NonNullable<z.input<(typeof OpenClawSchemaShape)[K]>>;
};

type ConfigAuthoringOverrides = {
  /** @deprecated Doctor-only legacy input. */
  audit?: AuditConfig;
  /** ACP integration settings. */
  acp?: AcpConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (interactive for Bash). */
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
  /** Browser automation and browser plugin integration settings. */
  browser?: BrowserConfig;
  /** Skill loading and bundled skill configuration. */
  skills?: SkillsConfig;
  /** Plugin registry/install/runtime configuration. */
  plugins?: PluginsConfig;
  /** Model providers, model catalog, pricing, and catalog merge policy. */
  models?: ModelsConfig;
  /** Node-host pairing and remote command node settings. */
  nodeHost?: NodeHostConfig;
  /** Agent definitions, defaults, bindings, and runtime policy. */
  agents?: AgentsConfig;
  /** Tool exposure, policy, web/media tools, exec, and code-mode settings. */
  tools?: ToolsConfig;
  /** Legacy/direct agent bindings used by runtime resolution. */
  bindings?: AgentBinding[];
  /** Broadcast command and delivery settings. */
  broadcast?: BroadcastConfig;
  /** Message formatting, delivery, and action settings. */
  messages?: MessagesConfig;
  /** Shared text-to-speech defaults. Agent and channel overrides layer over this config. */
  tts?: TtsConfig;
  /** Chat command settings. */
  commands?: CommandsConfig;
  /** Channel defaults, built-in channel sections, and plugin-owned channel config. */
  channels?: ChannelsConfig;
  /** Cron schedule and retention settings. */
  cron?: CronConfig;
  /** Transcript persistence and export settings. */
  transcripts?: TranscriptsConfig;
  /** Runtime hook registration and queue behavior. */
  hooks?: HooksConfig;
  /** Gateway server, auth, UI, node-pairing, and dispatch settings. */
  gateway?: GatewayConfig;
  /** Memory indexing/search configuration. */
  memory?: MemoryConfig;
  /** MCP client/server and Codex MCP approval configuration. */
  mcp?: McpConfig;
  /** Network-level SSRF protection via an operator-managed forward proxy. */
  proxy?: ProxyConfig;
};

/** Top-level OpenClaw config, retaining authoring contracts outside the current schema. */
export type OpenClawConfig = Omit<SchemaConfig, keyof ConfigAuthoringOverrides> &
  ConfigAuthoringOverrides;

/** Config input shape accepted before model provider defaults are fully materialized. */
export type OpenClawConfigInput = Omit<OpenClawConfig, "models"> & {
  models?: ModelsConfigInput;
};

declare const openClawConfigStateBrand: unique symbol;

type BrandedConfigState<TState extends string> = OpenClawConfig & {
  readonly [openClawConfigStateBrand]?: TState;
};

/** Source config after includes/env substitution, before runtime defaults. */
export type ResolvedSourceConfig = BrandedConfigState<"resolved-source">;
/** Runtime-materialized config with defaults/normalization applied. */
export type RuntimeConfig = BrandedConfigState<"runtime">;

export type ConfigValidationIssue = {
  errorCode?: string;
  fixHint?: string;
  code?: import("../plugins/manifest-types.js").PluginDiagnosticCode;
  source?: string;
  /** Dot-path to the invalid or legacy config value. */
  path: string;
  /** Structured validator path used internally for lossless source diagnostics. */
  pathSegments?: Array<string | number>;
  /** Human-readable validation message. */
  message: string;
  /** Optional allowed values shown to the operator. */
  allowedValues?: string[];
  /** Number of allowed values omitted from the display list. */
  allowedValuesHiddenCount?: number;
};

/** Dot-path and migration or rejection message for a legacy config value. */
export type LegacyConfigIssue = Pick<ConfigValidationIssue, "path" | "message">;

export type ConfigFileSnapshot = {
  /** Config file path that was read. */
  path: string;
  /** Lexical and canonical file paths reached while resolving $include directives. */
  includedPaths?: string[];
  /** Exact authored ownership for every successfully resolved $include directive. */
  includeProvenance?: readonly ConfigIncludeOwnership[];
  /** Temporary roster-only projection retained until write preparation uses generic ownership. */
  agentRosterIncludeOwned?: boolean;
  bindingsIncludeOwned?: boolean;
  /** Whether the config file exists on disk. */
  exists: boolean;
  /** Raw file contents before parsing; null when missing. */
  raw: string | null;
  /** Parsed JSON/JSONC/YAML value before schema normalization. */
  parsed: unknown;
  /** Internal include-expanded authored values paired with sourceConfigBeforeMigrations. */
  authoredConfig?: OpenClawConfig;
  /** Include/env-resolved source before raw compatibility migrations. */
  sourceConfigBeforeMigrations?: ResolvedSourceConfig;
  /**
   * Config authored on disk after $include resolution and ${ENV} substitution,
   * but BEFORE runtime defaults are applied.
   */
  sourceConfig: ResolvedSourceConfig;
  /**
   * Config after $include resolution and ${ENV} substitution, but BEFORE runtime
   * defaults are applied. Use this for config set/unset operations to avoid
   * leaking runtime defaults into the written config file.
   */
  resolved: ResolvedSourceConfig;
  valid: boolean;
  /** Runtime-shaped config used by in-process readers. */
  runtimeConfig: RuntimeConfig;
  /** @deprecated Prefer runtimeConfig. */
  config: RuntimeConfig;
  hash?: string;
  readError?: { code: string | null };
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
