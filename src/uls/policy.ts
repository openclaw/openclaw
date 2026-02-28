/**
 * ULS Policy & ACL Enforcement
 *
 * Server-side policy gating for cross-agent memory access.
 * This module enforces scope and ACL rules — prompts are NOT
 * security boundaries; all enforcement happens here.
 */

import type { UlsAcl, UlsConfig, UlsRecord, UlsScope } from "./types.js";

// ---------------------------------------------------------------------------
// Policy check results
// ---------------------------------------------------------------------------

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

// ---------------------------------------------------------------------------
// Scope escalation policy
// ---------------------------------------------------------------------------

/**
 * Check whether an agent is allowed to write at the given scope.
 * Default scope is "self" — escalation to "team" or "global"
 * requires explicit configuration.
 */
export function canWriteAtScope(
  agentId: string,
  requestedScope: UlsScope,
  config: UlsConfig,
): PolicyDecision {
  if (requestedScope === "self") {
    return { allowed: true };
  }

  const agentScopes = config.allowedScopes[agentId] ?? ["self"];
  if (!agentScopes.includes(requestedScope)) {
    return {
      allowed: false,
      reason: `Agent '${agentId}' is not authorized to write at scope '${requestedScope}'. Allowed: [${agentScopes.join(", ")}]`,
    };
  }

  // For "team" scope, verify agent belongs to at least one team group
  if (requestedScope === "team") {
    const inTeam = Object.values(config.teamGroups).some((members) => members.includes(agentId));
    if (!inTeam) {
      return {
        allowed: false,
        reason: `Agent '${agentId}' is not a member of any team group.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Check whether an agent is allowed to read a specific record.
 *
 * Rules:
 *   1. scope=self → only the owning agent
 *   2. scope=team → agents in the same team group(s)
 *   3. scope=global → any agent (subject to ACL)
 *   4. ACL deny list overrides allow
 *   5. ACL allow list (if non-empty) restricts to listed agents/groups
 */
export function canReadRecord(
  readerAgentId: string,
  record: UlsRecord,
  config: UlsConfig,
): PolicyDecision {
  // Owner can always read own records
  if (readerAgentId === record.agentId) {
    return { allowed: true };
  }

  // Scope check
  switch (record.scope) {
    case "self":
      return {
        allowed: false,
        reason: `Record scope is 'self'; only agent '${record.agentId}' may read it.`,
      };

    case "team": {
      const writerTeams = getAgentTeams(record.agentId, config);
      const readerTeams = getAgentTeams(readerAgentId, config);
      const sharedTeam = writerTeams.some((t) => readerTeams.includes(t));
      if (!sharedTeam) {
        return {
          allowed: false,
          reason: `Agent '${readerAgentId}' shares no team group with record owner '${record.agentId}'.`,
        };
      }
      break;
    }

    case "global":
      // Allowed by scope — fall through to ACL check
      break;

    default:
      return { allowed: false, reason: `Unknown scope '${record.scope as string}'.` };
  }

  // ACL check
  return checkAcl(readerAgentId, record.acl, config);
}

// ---------------------------------------------------------------------------
// ACL helpers
// ---------------------------------------------------------------------------

function checkAcl(agentId: string, acl: UlsAcl, config: UlsConfig): PolicyDecision {
  // Deny list takes precedence
  if (acl.deny && acl.deny.length > 0) {
    if (matchesAclEntry(agentId, acl.deny, config)) {
      return {
        allowed: false,
        reason: `Agent '${agentId}' is on the deny list.`,
      };
    }
  }

  // Allow list: if specified, agent must be on it
  if (acl.allow && acl.allow.length > 0) {
    if (!matchesAclEntry(agentId, acl.allow, config)) {
      return {
        allowed: false,
        reason: `Agent '${agentId}' is not on the allow list.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Check whether an agentId matches any ACL entry.
 * Entries can be direct agent IDs or group names.
 */
function matchesAclEntry(agentId: string, entries: string[], config: UlsConfig): boolean {
  for (const entry of entries) {
    // Direct match
    if (entry === agentId) {
      return true;
    }
    // Group match
    const groupMembers = config.teamGroups[entry];
    if (groupMembers && groupMembers.includes(agentId)) {
      return true;
    }
  }
  return false;
}

/**
 * Get all team group names an agent belongs to.
 */
function getAgentTeams(agentId: string, config: UlsConfig): string[] {
  const teams: string[] = [];
  for (const [groupName, members] of Object.entries(config.teamGroups)) {
    if (members.includes(agentId)) {
      teams.push(groupName);
    }
  }
  return teams;
}

// ---------------------------------------------------------------------------
// Validate record schema version
// ---------------------------------------------------------------------------

import { ULS_SCHEMA_VERSION } from "./types.js";

export function validateSchemaVersion(record: UlsRecord): PolicyDecision {
  if (record.schemaVersion !== ULS_SCHEMA_VERSION) {
    return {
      allowed: false,
      reason: `Schema version mismatch: expected ${ULS_SCHEMA_VERSION}, got ${record.schemaVersion}.`,
    };
  }
  return { allowed: true };
}
