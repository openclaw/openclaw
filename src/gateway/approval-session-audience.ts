import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  buildLatestSubagentSessionListReadIndex,
  getLatestLiveSubagentRunByChildSessionKey,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareOptionalSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS } from "./operator-approval-store.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";

/** Resolves the source session and its operator-visible ancestor audience. */
function resolveApprovalSessionAudience(
  cfg: OpenClawConfig,
  persisted: boolean,
  source: string,
  sourceAgentId?: string | null,
  sourceMemory?: ReturnType<typeof captureSessionEntryMetadataRead>,
): string[] {
  const canonicalize = (sessionKey: string | null | undefined, relativeToSessionKey?: string) => {
    const raw = sessionKey?.trim();
    if (!raw) {
      return null;
    }
    if (!relativeToSessionKey) {
      return canonicalizeApprovalSourceStreamKey(cfg, raw, sourceAgentId).trim() || null;
    }
    const relativeAgentId = resolveSessionStoreAgentId(cfg, relativeToSessionKey);
    const canonical = resolveSessionStoreKey({
      cfg,
      sessionKey: raw,
      storeAgentId: relativeAgentId,
    });
    return (
      (canonical ? resolveApprovalSourceStreamKey(canonical, relativeAgentId) : canonical).trim() ||
      null
    );
  };
  const sourceSessionKey = canonicalize(source);
  if (!sourceSessionKey) {
    return [];
  }
  const queued = new Set<string>([sourceSessionKey]);
  const pending = [sourceSessionKey];
  const enqueue = (sessionKey: string | null) => {
    if (
      !sessionKey ||
      queued.has(sessionKey) ||
      pending.length >= OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS
    ) {
      return;
    }
    queued.add(sessionKey);
    pending.push(sessionKey);
  };
  for (const sessionKey of pending) {
    const subagentLineage = persisted
      ? buildLatestSubagentSessionListReadIndex([sessionKey]).getLatestSubagentRun(sessionKey)
      : getLatestLiveSubagentRunByChildSessionKey(sessionKey);
    const registryParents = [
      subagentLineage?.controllerSessionKey,
      subagentLineage?.requesterSessionKey,
    ]
      .map((parent) => canonicalize(parent, sessionKey))
      .filter((candidate): candidate is string => Boolean(candidate));
    if (registryParents.length > 0) {
      // Current registry ownership supersedes session metadata, whose spawnedBy
      // link can remain stale after steering or restart.
      for (const parentSessionKey of registryParents) {
        enqueue(parentSessionKey);
      }
      continue;
    }
    const parsed = parseAgentSessionKey(sessionKey);
    const target =
      parsed?.rest.toLowerCase() === "global"
        ? { agentId: normalizeAgentId(parsed.agentId), sessionKey: "global" }
        : { agentId: resolveSessionStoreAgentId(cfg, sessionKey), sessionKey };
    const memory = isIncognitoSessionKey(sessionKey)
      ? sessionKey === sourceSessionKey
        ? sourceMemory
        : captureSessionEntryMetadataRead(target, () => getAsyncWorkSignal()?.throwIfAborted())
      : undefined;
    const storedLineage = memory
      ? memory.readCurrent()
      : loadSessionEntryReadOnly({
          ...target,
          clone: false,
          hydrateSkillPromptRefs: false,
        });
    const parentSessionKey = storedLineage?.parentSessionKey?.trim()
      ? storedLineage.parentSessionKey
      : storedLineage?.spawnedBy;
    enqueue(canonicalize(parentSessionKey, sessionKey));
  }
  return pending;
}

/** Canonicalize one source key against config: agent scoping, main-key aliases, global sentinel. */
function canonicalizeApprovalSourceStreamKey(
  cfg: OpenClawConfig,
  sessionKey: string,
  sourceAgentId?: string | null,
): string {
  const ownerAgentId = normalizeAgentId(sourceAgentId ?? resolveDefaultAgentId(cfg));
  // Unscoped source aliases (e.g. "child", "main") must resolve against the
  // raising agent's store, not the default agent's, or multi-agent audiences
  // route to the wrong session streams.
  const lowered = sessionKey.trim().toLowerCase();
  const scoped =
    parseAgentSessionKey(sessionKey) || lowered === "global" || lowered === "unknown"
      ? sessionKey
      : `agent:${ownerAgentId}:${sessionKey}`;
  const canonical = resolveSessionStoreKey({ cfg, sessionKey: scoped });
  // Storage uses the bare global sentinel, while live session streams are
  // agent-scoped so one agent cannot receive another's global events.
  return resolveApprovalSourceStreamKey(canonical, ownerAgentId);
}

/** Preserves source routing when lineage is unavailable, after read preparation settles. */
export async function resolveApprovalSessionAudienceWithFallback(
  sourceSessionKey: string,
  sourceAgentId?: string | null,
): Promise<string[]> {
  const memory = captureSessionEntryMetadataRead(
    {
      sessionKey: sourceSessionKey,
      ...(sourceAgentId ? { agentId: sourceAgentId } : {}),
    },
    () => getAsyncWorkSignal()?.throwIfAborted(),
  );
  const initial = memory?.readCurrent();
  let persisted: boolean;
  do {
    persisted = await prepareOptionalSubagentSessionListReadCache();
    getAsyncWorkSignal()?.throwIfAborted();
  } while (persisted && !getSubagentSessionListReadSnapshotIdentity());
  if (memory) {
    const current = memory.readCurrent();
    if (
      current?.sessionId !== initial?.sessionId ||
      current?.lifecycleRevision !== initial?.lifecycleRevision
    ) {
      throw new Error("Approval source session changed during preparation");
    }
  }
  try {
    return resolveApprovalSessionAudience(
      getRuntimeConfig(),
      persisted,
      sourceSessionKey,
      sourceAgentId,
      memory,
    );
  } catch {
    return [resolveApprovalFallbackAudienceSessionKey(sourceSessionKey, sourceAgentId)];
  }
}

function resolveApprovalFallbackAudienceSessionKey(
  sourceSessionKey: string,
  sourceAgentId?: string | null,
): string {
  try {
    return canonicalizeApprovalSourceStreamKey(getRuntimeConfig(), sourceSessionKey, sourceAgentId);
  } catch {
    return resolveApprovalSourceStreamKey(sourceSessionKey, sourceAgentId);
  }
}

/** Best-effort stream key used when lineage lookup is unavailable. */
export function resolveApprovalSourceStreamKey(
  sourceSessionKey: string,
  sourceAgentId?: string | null,
): string {
  const normalizedSessionKey = sourceSessionKey.trim();
  const lowered = normalizedSessionKey.toLowerCase();
  // Subscribers only know agent-scoped stream keys, so raw fallback inputs
  // (bare "global", "main", unscoped child aliases) must scope to the raising
  // agent or the persisted audience is unreachable exactly when lineage
  // lookup already failed. "unknown" has no stream and stays bare.
  if (!sourceAgentId || lowered === "unknown" || parseAgentSessionKey(normalizedSessionKey)) {
    return normalizedSessionKey;
  }
  const agentId = normalizeAgentId(sourceAgentId);
  return lowered === "global"
    ? `agent:${agentId}:global`
    : `agent:${agentId}:${normalizedSessionKey}`;
}
