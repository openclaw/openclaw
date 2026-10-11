import type { SessionEntryCurrentFacts } from "./session-entry-current.types.js";

/** Both native publication and worker reads carry the same content-free capability facts. */
export function projectSessionEntryCapabilityFacts(entry: SessionEntryCurrentFacts) {
  return {
    sessionId: entry.sessionId,
    spawnedBy: entry.spawnedBy,
    spawnDepth: entry.spawnDepth,
    completionOwnerSessionKey: entry.completionOwnerSessionKey,
    subagentRole: entry.subagentRole,
    subagentControlScope: entry.subagentControlScope,
    inheritedToolPolicyVersion: entry.inheritedToolPolicyVersion,
    inheritedToolPolicySource: entry.inheritedToolPolicySource,
    inheritedToolAllow: Array.isArray(entry.inheritedToolAllow)
      ? [...entry.inheritedToolAllow]
      : entry.inheritedToolAllow,
    inheritedToolDeny: Array.isArray(entry.inheritedToolDeny)
      ? [...entry.inheritedToolDeny]
      : entry.inheritedToolDeny,
  };
}
