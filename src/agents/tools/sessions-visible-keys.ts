import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
} from "./sessions-access.js";

export async function resolveVisibleSessionKeys(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  sandboxed?: boolean;
  limit?: number;
}): Promise<Set<string> | null> {
  const { cfg } = params;
  const { effectiveRequesterKey, restrictToSpawned } = resolveSandboxedSessionToolContext({
    cfg,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
  });
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg,
    sandboxed: params.sandboxed === true,
  });
  if (visibility === "all") {
    return null;
  }

  const a2aPolicy = createAgentToAgentPolicy(cfg);
  const guard = await createSessionVisibilityGuard({
    action: "list",
    requesterSessionKey: effectiveRequesterKey,
    visibility,
    a2aPolicy,
  });
  // Omit `limit` unless the caller set it: default cap would drop visible keys for
  // workspaces with more sessions than the slice, breaking search/recall FTS filtering.
  const listParams: {
    includeGlobal: boolean;
    includeUnknown: boolean;
    spawnedBy?: string;
    limit?: number;
  } = {
    includeGlobal: !restrictToSpawned,
    includeUnknown: !restrictToSpawned,
  };
  if (restrictToSpawned) {
    listParams.spawnedBy = effectiveRequesterKey;
  }
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    listParams.limit = Math.max(1, Math.floor(params.limit));
  }
  const list = await callGateway<{ sessions: Array<{ key?: unknown }> }>({
    method: "sessions.list",
    params: listParams,
  });
  const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
  const visible = new Set<string>();
  for (const entry of sessions) {
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    if (!key || key === "unknown") {
      continue;
    }
    const access = guard.check(key);
    if (access.allowed) {
      visible.add(key);
    }
  }
  return visible;
}
