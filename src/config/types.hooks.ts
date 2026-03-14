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

export type HooksImapConfig = {
  /** Himalaya account name (from himalaya config.toml) */
  account?: string;
  /** IMAP folder to watch (default: "INBOX") */
  folder?: string;
  /** Poll interval in seconds (default: 30) */
  pollIntervalSeconds?: number;
  /** Include message body in hook payload (default: true) */
  includeBody?: boolean;
  /** Max body bytes to include (default: 20000) */
  maxBytes?: number;
  /** Mark messages as seen after processing (default: true) */
  markSeen?: boolean;
  /** Callback URL for hook delivery (default: http://127.0.0.1:<port>/hooks/imap) */
  hookUrl?: string;
  /** Optional model override for IMAP hook processing (provider/model or alias). */
  model?: string;
  /** Optional thinking level override for IMAP hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  /** DANGEROUS: Disable external content safety wrapping for IMAP hooks. */
  allowUnsafeExternalContent?: boolean;
  /** Path to himalaya config file (optional, uses default if omitted) */
  himalayaConfig?: string;
  /** Filter query for envelopes (default: "not flag Seen") */
  query?: string;
  /** Allowlist of sender email addresses permitted to reach agent hooks. */
  allowedSenders?: string[];
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
  imap?: HooksImapConfig;
  /** Internal agent event hooks */
  internal?: InternalHooksConfig;
};
import type { InstallRecordBase } from "./types.installs.js";
