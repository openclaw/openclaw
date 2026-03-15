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
  /** Route this hook to a specific agent (unknown ids fall back to the default agent). */
  agentId?: string;
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
    | "irc"
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

export type HooksGmailGcpConfig = {
  /** GCP project ID (auto-detected from topic path or gog credentials if omitted) */
  projectId?: string;
  /** Service account key JSON string (or use serviceAccountKeyFile) */
  serviceAccountKey?: string;
  /** Path to service account key JSON file */
  serviceAccountKeyFile?: string;
  /** Auto-create Pub/Sub topic and enable required APIs on startup */
  autoSetup?: boolean;
  /** Public push endpoint URL for Pub/Sub subscription (used when Tailscale is not configured) */
  pushEndpoint?: string;
};

export type HooksGmailGogConfig = {
  /** OAuth refresh token for gog (skips interactive auth if provided) */
  refreshToken?: string;
  /** Path to gog credentials.json file to copy/use */
  credentialsFile?: string;
  /** OAuth client ID (required with refreshToken) */
  clientId?: string;
  /** OAuth client secret (required with refreshToken) */
  clientSecret?: string;
  /** Google API services to enable (default: ["gmail"]) */
  services?: string[];
  /** OAuth scopes to request (default: Gmail scopes only). Add Sheets/Drive/Docs scopes as needed. */
  scopes?: string[];
};

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
  /** GCP/Pub/Sub configuration for config-driven setup */
  gcp?: HooksGmailGcpConfig;
  /** gog (Gmail CLI) configuration for config-driven auth */
  gog?: HooksGmailGogConfig;
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
    /** Auth key for automated Tailscale login (skips interactive auth) */
    authKey?: string;
  };
  /** Poll interval in seconds as a fallback to Pub/Sub push (0 to disable, default 60). */
  pollIntervalSeconds?: number;
  /** Channel to deliver email notifications to (e.g. "telegram", "whatsapp", "last"). */
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
  /** Specific chat/user ID to deliver to (optional, channel-specific). */
  to?: string;
  /** Whether to deliver the agent response to the channel (default true). */
  deliver?: boolean;
  /** Hook action: "agent" wakes the LLM, "wake" just notifies (default "agent"). */
  action?: "agent" | "wake";
  /** Custom message template for the email notification (uses {{messages[0].from}} etc). */
  messageTemplate?: string;
  /** Optional model override for Gmail hook processing (provider/model or alias). */
  model?: string;
  /** Optional thinking level override for Gmail hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};

export type InternalHookHandlerConfig = {
  /** Event key to listen for (e.g., 'command:new', 'message:received', 'message:transcribed', 'session:start') */
  event: string;
  /** Path to handler module (workspace-relative) */
  module: string;
  /** Export name from module (default: 'default') */
  export?: string;
};

export type HookConfig = {
  enabled?: boolean;
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type HookInstallRecord = InstallRecordBase & {
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

export type HooksConfig = {
  enabled?: boolean;
  path?: string;
  token?: string;
  /**
   * Default session key used for hook agent runs when no request/mapping session key is used.
   * If omitted, OpenClaw generates `hook:<uuid>` per request.
   */
  defaultSessionKey?: string;
  /**
   * Allow `sessionKey` from external `/hooks/agent` request payloads.
   * Default: false.
   */
  allowRequestSessionKey?: boolean;
  /**
   * Optional allowlist for explicit session keys (request + mapping). Example: ["hook:"].
   * Empty/omitted means no prefix restriction.
   */
  allowedSessionKeyPrefixes?: string[];
  /**
   * Restrict explicit hook `agentId` routing to these agent ids.
   * Omit or include `*` to allow any agent. Set `[]` to deny all explicit `agentId` routing.
   */
  allowedAgentIds?: string[];
  maxBodyBytes?: number;
  presets?: string[];
  transformsDir?: string;
  mappings?: HookMappingConfig[];
  gmail?: HooksGmailConfig;
  /** Internal agent event hooks */
  internal?: InternalHooksConfig;
};
import type { InstallRecordBase } from "./types.installs.js";
