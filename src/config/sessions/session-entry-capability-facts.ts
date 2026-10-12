import type { SessionEntryCurrentFacts } from "./session-entry-current.types.js";

/** Both native publication and worker reads carry the same content-free capability facts. */
export function projectSessionEntryCapabilityFacts(entry: SessionEntryCurrentFacts) {
  return {
    sessionId: entry.sessionId,
    incognito: entry.incognito,
    lifecycleRevision: entry.lifecycleRevision,
    modelSelectionLocked: entry.modelSelectionLocked,
    pluginOwnerId: entry.pluginOwnerId,
    agentHarnessId: entry.agentHarnessId,
    agentRuntimeOverride: entry.agentRuntimeOverride,
    initializationPending: entry.initializationPending,
    execHost: entry.execHost,
    execNode: entry.execNode,
    sandbox: entry.sandbox,
    sandboxMode: entry.sandboxMode,
    permissionMode: entry.permissionMode,
    sessionRoot: entry.sessionRoot,
    authProfileOverride: entry.authProfileOverride,
    authProfileOverrideSource: entry.authProfileOverrideSource,
    modelOverride: entry.modelOverride,
    providerOverride: entry.providerOverride,
    model: entry.model,
    modelProvider: entry.modelProvider,
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
