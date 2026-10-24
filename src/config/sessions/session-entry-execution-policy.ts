import type { SessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";

/** Content-free policy inputs retained by writes that outlive the creator's current turn. */
export function captureSessionExecutionPolicy(entry: SessionSharingEntry | undefined) {
  if (!entry) {
    return undefined;
  }
  return structuredClone({
    permissionMode: entry.permissionMode,
    execHost: entry.execHost,
    execNode: entry.execNode,
    execCwd: entry.execCwd,
    sandbox: entry.sandbox,
    sandboxMode: entry.sandboxMode,
    modelSelectionLocked: entry.modelSelectionLocked,
    providerOverride: entry.providerOverride,
    modelOverride: entry.modelOverride,
    modelOverrideSource: entry.modelOverrideSource,
    modelOverrideRouteResolution: entry.modelOverrideRouteResolution,
    modelOverrideFallbackOriginProvider: entry.modelOverrideFallbackOriginProvider,
    modelOverrideFallbackOriginModel: entry.modelOverrideFallbackOriginModel,
    inheritedToolPolicyVersion: entry.inheritedToolPolicyVersion,
    inheritedToolAllow: entry.inheritedToolAllow,
    inheritedToolDeny: entry.inheritedToolDeny,
    spawnedBy: entry.spawnedBy,
    parentSessionKey: entry.parentSessionKey,
    subagentRole: entry.subagentRole,
    subagentControlScope: entry.subagentControlScope,
    completionOwnerSessionKey: entry.completionOwnerSessionKey,
  });
}
