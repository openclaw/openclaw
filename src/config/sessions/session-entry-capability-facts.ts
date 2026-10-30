import type { SessionEntryCurrentFacts } from "./session-entry-current.types.js";

/** Capability readers share authority facts; model/auth routing belongs to the admitted turn. */
export function projectSessionEntryCapabilityFacts(entry: SessionEntryCurrentFacts) {
  return {
    sessionId: entry.sessionId,
    clientCapabilities: entry.clientCapabilities,
    createdVia: entry.createdVia,
    incognito: entry.incognito,
    lifecycleRevision: entry.lifecycleRevision,
    modelSelectionLocked: entry.modelSelectionLocked,
    pluginOwnerId: entry.pluginOwnerId,
    agentHarnessId: entry.agentHarnessId,
    agentRuntimeOverride: entry.agentRuntimeOverride,
    initializationPending: entry.initializationPending,
    execHost: entry.execHost,
    execNode: entry.execNode,
    deviceFolder: entry.deviceFolder ? { ...entry.deviceFolder } : undefined,
    sandbox: entry.sandbox,
    sandboxMode: entry.sandboxMode,
    permissionMode: entry.permissionMode,
    sessionRoot: entry.sessionRoot,
    spawnedBy: entry.spawnedBy,
    spawnDepth: entry.spawnDepth,
    completionOwnerSessionKey: entry.completionOwnerSessionKey,
    subagentRole: entry.subagentRole,
    subagentControlScope: entry.subagentControlScope,
    inheritedToolPolicyVersion: entry.inheritedToolPolicyVersion,
    inheritedToolPolicySource: entry.inheritedToolPolicySource,
    delegatedToolPolicy: structuredClone(entry.delegatedToolPolicy),
    inheritedToolAllow: Array.isArray(entry.inheritedToolAllow)
      ? [...entry.inheritedToolAllow]
      : entry.inheritedToolAllow,
    inheritedToolDeny: Array.isArray(entry.inheritedToolDeny)
      ? [...entry.inheritedToolDeny]
      : entry.inheritedToolDeny,
  };
}
