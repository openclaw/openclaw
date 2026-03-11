/**
 * Hyperion Integration Layer for OpenClaw
 *
 * This module replaces OpenClaw's single-tenant filesystem-based configuration
 * with a multi-tenant DynamoDB-backed implementation for the Nova Personal
 * Assistant Platform (assistant.nova.amazon.com).
 *
 * Architecture:
 *
 *   OpenClaw (single-tenant)         Hyperion (multi-tenant)
 *   ─────────────────────────        ───────────────────────────
 *   openclaw.json5 on disk     →     tenant_config DynamoDB table
 *   {channel}-pairing.json     →     pairing_codes DynamoDB table (TTL)
 *   {channel}-allowFrom.json   →     channel_config DynamoDB table
 *   session keys: "main"       →     session keys: "tenant_{userId}:{agentId}:main"
 *   in-memory config cache     →     in-memory LRU with 1-min TTL
 *   file lock concurrency      →     DynamoDB conditional writes
 *
 * Entry points:
 *   - TenantConfigLoader:       loadConfig() replacement (per-tenant from DynamoDB)
 *   - ChannelIdentityResolver:  webhook identity resolution (platform_user_id → user_id)
 *   - HyperionPairingStore:     pairing-store.ts replacement (DynamoDB-backed)
 *   - Session helpers:          tenant-scoped session key management
 *   - HyperionDynamoDBClient:   DynamoDB operations for all three tables
 *   - createHyperionRuntime:    one-call setup of the full integration layer
 */

// Types
export { DEFAULT_AGENT_ID } from "./types.js";
export type {
  ChannelIdentityResolution,
  ChannelLink,
  ChannelRuntimeConfig,
  CachedChannelIdentity,
  CachedTenantConfig,
  HyperionDynamoDBConfig,
  HyperionPlatform,
  PairingCode,
  TenantConfig,
} from "./types.js";

// DynamoDB client
export { HyperionDynamoDBClient } from "./dynamodb-client.js";
export type { DynamoDBDocClient } from "./dynamodb-client.js";

// Config loader (replaces io.ts loadConfig)
export { TenantConfigLoader, TenantNotFoundError } from "./tenant-config-loader.js";

// Identity resolution (replaces channel-config.ts resolution + pairing allowFrom)
export { ChannelIdentityResolver } from "./channel-identity-resolver.js";

// Pairing store (replaces pairing-store.ts file-based store)
export { HyperionPairingStore } from "./pairing-store.js";

// Session management (replaces session.ts with tenant-scoped keys)
export {
  buildPortalSessionKey,
  buildChannelSessionKey,
  buildTenantMemoryNamespace,
  extractAgentId,
  extractInnerSessionKey,
  extractTenantId,
  isSessionForAgent,
  isSessionForTenant,
} from "./session-manager.js";

// Runtime factory
export { createHyperionRuntime, type HyperionRuntime } from "./runtime.js";
