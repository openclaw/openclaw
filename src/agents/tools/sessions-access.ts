/**
 * Session visibility and access helpers for session tools.
 *
 * Adds OpenClaw session-key alias normalization and sandbox requester scoping over SDK visibility contracts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  logSessionOwnershipLookupFailure,
  lookupFailedDenialMessage,
} from "../../plugin-sdk/session-visibility-internal.js";
import {
  createSessionVisibilityChecker,
  resolveSandboxSessionToolsVisibility,
  type AgentToAgentPolicy,
  type SessionAccessAction,
  type SessionAccessResult,
  type SessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  lookupRequesterSessionOwnership,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-resolution.js";

export {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";

/** Check one prepared target without re-listing the requester's spawned sessions. */
export async function resolveSessionToolAccess(params: {
  action: SessionAccessAction;
  displayAction?: SessionAccessAction | "search";
  defaultAgentId?: string;
  requesterAgentId?: string;
  requesterSessionKey: string;
  targetSessionKey: string;
  requesterOwned: boolean;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
}): Promise<SessionAccessResult> {
  const createChecker = (requesterOwned: boolean) =>
    createSessionVisibilityChecker({
      action: params.action,
      defaultAgentId: params.defaultAgentId,
      requesterAgentId: params.requesterAgentId,
      requesterSessionKey: params.requesterSessionKey,
      visibility: params.visibility,
      a2aPolicy: params.a2aPolicy,
      spawnedKeys: requesterOwned ? new Set([params.targetSessionKey]) : new Set(),
    });
  const initial = createChecker(params.requesterOwned).check(params.targetSessionKey);
  if (initial.allowed || params.requesterOwned || params.action === "list") {
    return initial;
  }
  if (params.visibility !== "tree" && params.visibility !== "all") {
    return initial;
  }
  if (
    params.targetSessionKey === params.requesterSessionKey ||
    params.targetSessionKey === "current"
  ) {
    return initial;
  }
  try {
    resolveAgentIdFromSessionKey(params.targetSessionKey, params.defaultAgentId);
  } catch {
    return initial;
  }
  const ownership = await lookupRequesterSessionOwnership({
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: params.targetSessionKey,
  });
  if (!ownership.ok) {
    logSessionOwnershipLookupFailure({
      requesterSessionKey: params.requesterSessionKey,
      failure: ownership.error,
    });
    return {
      allowed: false,
      status: "forbidden",
      error: lookupFailedDenialMessage(params.displayAction ?? params.action, ownership.error.kind),
    };
  }
  return ownership.value ? createChecker(true).check(params.targetSessionKey) : initial;
}

/** Resolves the requester context used to filter sandboxed session-tool access. */
export function resolveSandboxedSessionToolContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): {
  mainKey: string;
  alias: string;
  visibility: "spawned" | "all";
  requesterInternalKey: string | undefined;
  effectiveRequesterKey: string;
  restrictToSpawned: boolean;
} {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const visibility = resolveSandboxSessionToolsVisibility(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.agentSessionKey);
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : undefined;
  const effectiveRequesterKey = requesterInternalKey ?? alias;
  const restrictToSpawned =
    params.sandboxed === true &&
    visibility === "spawned" &&
    Boolean(requesterInternalKey) &&
    !isSubagentSessionKey(requesterInternalKey);
  // Main sessions can see all sessions; sandboxed non-subagent callers stay scoped to spawned rows.
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}
