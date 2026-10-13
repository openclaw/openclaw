import type { SessionLifecycleTimestamps } from "../../config/sessions/lifecycle.types.js";
import { resolveResetPreservedSelection } from "../../config/sessions/reset-preserved-selection.js";
import {
  evaluateSessionFreshness,
  type SessionFreshness,
  type SessionResetPolicy,
} from "../../config/sessions/reset.js";
import { preserveSessionInheritedToolPolicy } from "../../config/sessions/session-entry-lineage.js";
import { preserveCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { selectSessionModelOverride } from "../../config/sessions/session-entry-selection.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";

/** Builds the durable session fields retained across a reply-session rollover. */
export function resolveReplySessionRolloverState(
  entry: SessionEntry,
  sessionKey: string,
): Partial<InternalSessionEntry> {
  const preservedSelection = resolveResetPreservedSelection({ entry });
  // Stable ACP rows predate durable creation stamps. Preserve their restrictions
  // fail-closed so rollover cannot turn an existing child into a root session.
  const preserveSpawnLineage =
    (entry.createdVia === "spawn" && Boolean(entry.spawnedBy)) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey);
  return {
    thinkingLevel: entry.thinkingLevel,
    verboseLevel: entry.verboseLevel,
    traceLevel: entry.traceLevel,
    reasoningLevel: entry.reasoningLevel,
    ttsAuto: entry.ttsAuto,
    responseUsage: entry.responseUsage,
    ...selectSessionModelOverride(preservedSelection),
    communication: preservedSelection.communication,
    authProfileOverride: preservedSelection.authProfileOverride,
    authProfileOverrideSource: preservedSelection.authProfileOverrideSource,
    authProfileOverrideCompactionCount: preservedSelection.authProfileOverrideCompactionCount,
    label: entry.label,
    autoLabel: entry.autoLabel,
    displayName: entry.displayName,
    category: entry.category,
    sidebarRoot: entry.sidebarRoot,
    // Notice debt survives rollover: erasing it here would recreate the
    // silent ambiguous-loss outcome the debt exists to prevent.
    pendingDeliveryNotice: entry.pendingDeliveryNotice,
    ...(preserveSpawnLineage
      ? {
          ...preserveSessionInheritedToolPolicy(entry),
          ...(entry.inheritedToolPolicySource === "sender" && entry.sessionRoot
            ? { sessionRoot: entry.sessionRoot }
            : {}),
          spawnedBy: entry.spawnedBy,
          spawnedBySenderIsOwner: entry.spawnedBySenderIsOwner,
          spawnedBySessionId: entry.spawnedBySessionId,
          spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
          spawnedCwd: entry.spawnedCwd,
          spawnDepth: entry.spawnDepth,
          subagentRole: entry.subagentRole,
          subagentControlScope: entry.subagentControlScope,
        }
      : {}),
    parentSessionKey: entry.parentSessionKey,
    parentSessionId: entry.parentSessionId,
    parentSessionLifecycleRevision: entry.parentSessionLifecycleRevision,
    forkedFromParent: entry.forkedFromParent,
    forkSource: entry.forkSource,
    ...preserveCreationStamp({}, entry),
    // Chat preferences survive rollover; native-runtime consent belongs to the old incarnation.
    permissionMode: entry.permissionMode,
    sandboxMode: entry.sandboxMode,
  };
}

export function resolveReplySessionFreshness(params: {
  entry: SessionEntry | undefined;
  skipImplicitExpiry: boolean;
  lifecycleTimestamps: SessionLifecycleTimestamps;
  now: number;
  resetPolicy: SessionResetPolicy;
}): SessionFreshness | undefined {
  if (!params.entry) {
    return undefined;
  }
  if (params.skipImplicitExpiry) {
    return { fresh: true };
  }
  return evaluateSessionFreshness({
    updatedAt: params.entry.updatedAt,
    sessionStartedAt: params.lifecycleTimestamps.sessionStartedAt,
    lastInteractionAt: params.lifecycleTimestamps.lastInteractionAt,
    now: params.now,
    policy: params.resetPolicy,
  });
}
