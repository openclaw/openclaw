import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  listSpawnedSessionKeys,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";
import {
  buildAgentMainSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-resolution.js";

export {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  listSpawnedSessionKeys,
  resolveEffectiveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";

export function resolveSandboxedSessionToolContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
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
  const requesterSessionKey = normalizeOptionalString(params.agentSessionKey);
  const requesterAgentId =
    params.agentId ??
    (requesterSessionKey ? resolveAgentIdFromSessionKey(requesterSessionKey) : undefined);
  const visibility = resolveSandboxSessionToolsVisibility(params.cfg, requesterAgentId);
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : undefined;
  const effectiveRequesterKey =
    requesterAgentId && requesterAgentId !== resolveAgentIdFromSessionKey(requesterInternalKey)
      ? (() => {
          const parsed = parseAgentSessionKey(requesterInternalKey ?? requesterSessionKey);
          if (parsed) {
            return `agent:${normalizeAgentId(requesterAgentId)}:${parsed.rest}`;
          }
          return buildAgentMainSessionKey({
            agentId: requesterAgentId,
            mainKey,
          });
        })()
      : (requesterInternalKey ?? alias);
  const hasRequesterScope = !!requesterInternalKey || !!params.agentId;
  const restrictToSpawned =
    params.sandboxed === true &&
    visibility === "spawned" &&
    hasRequesterScope &&
    !isSubagentSessionKey(effectiveRequesterKey);
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}
