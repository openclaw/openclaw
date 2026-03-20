import { CHANNEL_IDS } from "../channels/registry.js";
import type { GatewayAccessConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RbacIdentity, RbacRole } from "./types.js";

/** Default role when access config is absent or user is unrecognized. */
const IMPLICIT_DEFAULT_ROLE: RbacRole = "user";

const VALID_ROLES = new Set<RbacRole>(["admin", "user", "guest"]);

/**
 * Set of known channel prefixes used to distinguish channel-qualified config
 * entries (e.g. "telegram:12345") from IDs that happen to contain colons
 * (e.g. Signal UUIDs "uuid:abc-def" or Matrix IDs "@user:server").
 *
 * Includes core channels plus common extension channel IDs.
 */
const KNOWN_CHANNEL_PREFIXES: ReadonlySet<string> = new Set<string>([
  ...CHANNEL_IDS.map((id) => id.toLowerCase()),
  // Extension channels not in CHANNEL_IDS
  "matrix",
  "msteams",
  "zalo",
  "zalouser",
  "web",
  "voice-call",
  "voicecall",
]);

/**
 * Check whether a config entry is channel-qualified (e.g. "telegram:12345")
 * by verifying the prefix before the first colon is a known channel name.
 */
function isChannelQualifiedEntry(entry: string): boolean {
  const colonIdx = entry.indexOf(":");
  if (colonIdx < 1) {
    return false;
  }
  const prefix = entry.slice(0, colonIdx).trim().toLowerCase();
  return KNOWN_CHANNEL_PREFIXES.has(prefix);
}

function parseRole(value: unknown): RbacRole | null {
  if (typeof value !== "string") {
    return null;
  }
  return VALID_ROLES.has(value as RbacRole) ? (value as RbacRole) : null;
}

/**
 * Build an RbacIdentity from a raw senderId and optional channel name.
 * Handles both `channel:id` qualified format and bare IDs.
 */
export function buildRbacIdentity(params: { senderId: string; channel?: string }): RbacIdentity {
  const { senderId, channel } = params;
  const trimmedId = senderId.trim();
  const trimmedChannel = channel?.trim() ?? "";

  // If senderId already contains a colon prefix, treat as qualified
  if (!trimmedChannel && trimmedId.includes(":")) {
    const colonIdx = trimmedId.indexOf(":");
    return {
      senderId: trimmedId.slice(colonIdx + 1),
      channel: trimmedId.slice(0, colonIdx),
      qualifiedId: trimmedId,
    };
  }

  const qualifiedId = trimmedChannel ? `${trimmedChannel}:${trimmedId}` : trimmedId;
  return { senderId: trimmedId, channel: trimmedChannel || undefined, qualifiedId };
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Check whether a config entry matches a sender identity.
 *
 * Match precedence:
 * 1. Qualified match (entry contains `:`) — matches `identity.qualifiedId` exactly.
 * 2. Bare match (entry without `:`) — matches `identity.senderId` on any channel.
 *    This is intentional convenience for single-channel or cross-channel admin IDs,
 *    but note that in multi-channel deployments a bare ID like "12345" could match
 *    different users on different channels.
 */
function matchesIdentity(entry: string, identity: RbacIdentity): boolean {
  const normalizedEntry = normalizeId(entry);
  if (normalizedEntry === normalizeId(identity.qualifiedId)) {
    return true;
  }
  if (normalizedEntry === normalizeId(identity.senderId)) {
    return true;
  }
  return false;
}

/**
 * Resolve the RBAC role for a sender given the gateway access config.
 *
 * Priority order:
 * 1. `adminUsers` list — any match → admin
 * 2. `roles` map — explicit entry → that role
 * 3. `defaultRole` or implicit default ("user")
 */
export function resolveUserRole(params: {
  identity: RbacIdentity;
  accessConfig?: GatewayAccessConfig;
}): RbacRole {
  const { identity, accessConfig } = params;
  if (!accessConfig) {
    return IMPLICIT_DEFAULT_ROLE;
  }

  // 1. adminUsers shorthand (takes precedence over roles map)
  if (accessConfig.adminUsers && accessConfig.adminUsers.length > 0) {
    const isAdmin = accessConfig.adminUsers.some((entry) => matchesIdentity(entry, identity));
    if (isAdmin) {
      return "admin";
    }
  }

  // 2. Explicit roles map (with runtime validation for config-loaded values)
  //    Qualified entries (containing `:`) take precedence over bare entries
  //    so that `telegram:12345: guest` wins over `12345: admin` when the
  //    sender comes from Telegram.
  if (accessConfig.roles && typeof accessConfig.roles === "object") {
    let bareMatch: RbacRole | null = null;
    for (const [entry, role] of Object.entries(accessConfig.roles)) {
      if (!matchesIdentity(entry, identity)) {
        continue;
      }
      const parsed = parseRole(role);
      if (!parsed) {
        // Invalid role in config, skip
        continue;
      }
      const isQualified = isChannelQualifiedEntry(entry);
      if (isQualified) {
        // Qualified match wins immediately
        return parsed;
      }
      // Bare match — remember but keep looking for a qualified match
      if (bareMatch === null) {
        bareMatch = parsed;
      }
    }
    if (bareMatch !== null) {
      return bareMatch;
    }
  }

  // 3. Default role (with runtime validation)
  const defaultRole = parseRole(accessConfig.defaultRole);
  return defaultRole ?? IMPLICIT_DEFAULT_ROLE;
}

/**
 * Convenience: resolve role directly from an OpenClawConfig.
 */
export function resolveUserRoleFromConfig(params: {
  cfg: OpenClawConfig;
  senderId: string;
  channel?: string;
}): RbacRole {
  const identity = buildRbacIdentity({ senderId: params.senderId, channel: params.channel });
  return resolveUserRole({ identity, accessConfig: params.cfg.gateway?.access });
}
