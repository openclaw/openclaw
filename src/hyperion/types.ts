import type { OpenClawConfig } from "../config/types.js";

/**
 * Supported external channel platforms for Hyperion.
 */
export type HyperionPlatform = "telegram" | "slack" | "whatsapp" | "discord";

/**
 * Default agent ID for single-instance users (backwards compatible).
 * [claude-infra] Multi-instance support
 */
export const DEFAULT_AGENT_ID = "main";

/**
 * A channel link record stored in the channel_config DynamoDB table.
 * Maps an external platform identity to an internal Hyperion user_id.
 *
 * Table schema:
 *   PK: platform (HyperionPlatform)
 *   SK: platform_user_id (string)
 *   GSI1PK: user_id (string)
 */
export type ChannelLink = {
  /** External platform identifier (e.g., "telegram", "slack"). */
  platform: HyperionPlatform;
  /** The user's identity on the external platform (e.g., Telegram user ID, Slack team+user). */
  platform_user_id: string;
  /** Internal Hyperion user ID this channel is linked to. */
  user_id: string;
  /** Agent instance this channel is bound to. Default: "main". [claude-infra] */
  agent_id: string;
  /** ISO timestamp when the channel was paired. */
  paired_at: string;
  /** Account ID within the channel (e.g., bot token alias). */
  channel_account_id: string;
  /** Platform-specific channel runtime configuration. */
  channel_config: ChannelRuntimeConfig;
};

/**
 * Platform-specific runtime configuration stored per channel link.
 * Subset of OpenClaw's per-account channel config, relevant for multi-tenant operation.
 */
export type ChannelRuntimeConfig = {
  /** DM policy for this channel link. */
  dmPolicy?: "pairing" | "open" | "disabled";
  /** Streaming mode for message delivery. */
  streaming?: "off" | "partial" | "block" | "progress";
  /** Max text chunk size for message splitting. */
  textChunkLimit?: number;
  /** Reply threading mode. */
  replyToMode?: string;
  /** Group message policy. */
  groupPolicy?: Record<string, unknown>;
  /** Bot token or Secrets Manager ARN reference. */
  credentialRef?: string;
  /** Additional platform-specific settings. */
  [key: string]: unknown;
};

/**
 * Tenant configuration stored in the tenant_config DynamoDB table.
 *
 * Table schema:
 *   PK: user_id (string), SK: agent_id (string) [claude-infra]
 */
export type TenantConfig = {
  /** Internal Hyperion user ID. */
  user_id: string;
  /** Agent instance ID. Default: "main". [claude-infra] */
  agent_id: string;
  /** User's display name. */
  display_name?: string;
  /** User's preferred model configuration. */
  model?: string;
  /** User's custom instructions for the agent. */
  custom_instructions?: string;
  /** User's subscription plan. */
  plan?: "free" | "pro" | "enterprise";
  /** Usage limits for the tenant. */
  limits?: {
    messages_per_day?: number;
    messages_per_month?: number;
  };
  /** Agent profile/persona settings. */
  profile?: Record<string, unknown>;
  /** Enabled tools for this tenant. */
  tools?: string[];
  /** Enabled skills for this tenant. */
  skills?: string[];
  /** ISO timestamp when config was last updated. */
  updated_at?: string;
};

/**
 * A pairing code record stored in the pairing_codes DynamoDB table.
 *
 * Table schema:
 *   PK: code (string)
 *   TTL: expires_at (number, epoch seconds)
 */
export type PairingCode = {
  /** The human-friendly pairing code. */
  code: string;
  /** Internal user ID that initiated the pairing. */
  user_id: string;
  /** Agent instance to bind the channel to. Default: "main". [claude-infra] */
  agent_id: string;
  /** Target platform for the pairing. */
  platform: HyperionPlatform;
  /** ISO timestamp when the code was created. */
  created_at: string;
  /** TTL attribute — epoch seconds when this code expires. */
  expires_at: number;
  /** Optional metadata from the pairing request. */
  meta?: Record<string, string>;
};

/**
 * Result of resolving an inbound channel message to a tenant.
 */
export type ChannelIdentityResolution = {
  /** The resolved internal user ID. */
  user_id: string;
  /** The resolved agent instance ID. [claude-infra] */
  agent_id: string;
  /** The channel link record. */
  channelLink: ChannelLink;
  /** The assembled OpenClawConfig for this tenant+agent. */
  config: OpenClawConfig;
};

/**
 * Per-user credentials stored encrypted in the user_credentials DynamoDB table.
 * Each field is optional — users only store the keys they actually use.
 *
 * Values are encrypted at rest via KMS envelope encryption with
 * encryption context { user_id: "<user_id>" } to ensure per-tenant isolation.
 */
export type UserCredentials = {
  /** Model provider API keys (e.g., openai, anthropic, google). */
  model_keys?: Record<string, string>;
  /** Tool API keys (e.g., brave_search, firecrawl, perplexity). */
  tool_keys?: Record<string, string>;
  /** Channel bot tokens (e.g., telegram, discord, slack). */
  channel_tokens?: Record<string, string>;
  /** Arbitrary additional credentials for custom tools/plugins. */
  custom?: Record<string, string>;
};

/**
 * Raw record stored in the user_credentials DynamoDB table.
 * The credentials_blob field contains KMS-encrypted JSON of UserCredentials.
 */
export type UserCredentialsRecord = {
  /** Internal Hyperion user ID (PK). */
  user_id: string;
  /** Agent instance ID (SK). Default: "main". [claude-infra] */
  agent_id: string;
  /** KMS-encrypted credentials blob (base64-encoded ciphertext). */
  credentials_blob: string;
  /** KMS key ID used for encryption (for key rotation tracking). */
  kms_key_id: string;
  /** ISO timestamp when credentials were last updated. */
  updated_at: string;
};

/**
 * Configuration for the Hyperion DynamoDB integration.
 */
export type HyperionDynamoDBConfig = {
  /** AWS region for DynamoDB. */
  region: string;
  /** Tenant config table name. */
  tenantConfigTableName: string;
  /** Channel config table name. */
  channelConfigTableName: string;
  /** Pairing codes table name. */
  pairingCodesTableName: string;
  /** User credentials table name. */
  userCredentialsTableName: string;
  /** KMS key ID (ARN or alias) for credential encryption. */
  credentialsKmsKeyId: string;
  /** GSI name for user_id lookups on channel_config. */
  channelConfigUserIdIndexName: string;
  /** Optional DynamoDB endpoint override (for local development). */
  endpoint?: string;
};

/**
 * Cache entry for tenant configs with TTL.
 */
export type CachedTenantConfig = {
  config: OpenClawConfig;
  cachedAt: number;
};

/**
 * Cache entry for channel identity resolution with TTL.
 */
export type CachedChannelIdentity = {
  channelLink: ChannelLink;
  cachedAt: number;
};
