import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  listSpawnedSessionKeys,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-resolution.js";

export type SessionToolsVisibility = "self" | "tree" | "agent" | "all";

export type AgentToAgentPolicy = {
  enabled: boolean;
  matchesAllow: (agentId: string) => boolean;
  isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};

export type SessionAccessAction = "history" | "send" | "list" | "status";

export type SessionAccessResult =
  | { allowed: true }
  | { allowed: false; error: string; status: "forbidden" };

export function resolveSessionToolsVisibility(
  cfg: OpenClawConfig,
  agentTools?: { sessions?: { visibility?: string } },
): SessionToolsVisibility {
  // Per-agent override takes priority
  if (agentTools?.sessions?.visibility) {
    const perAgent = agentTools.sessions.visibility.trim().toLowerCase()
    if (perAgent === "self" || perAgent === "tree" || perAgent === "agent" || perAgent === "all") {
      return perAgent
    }
  }
  // Fall back to global
  const raw = (cfg.tools as { sessions?: { visibility?: unknown } } | undefined)?.sessions
    ?.visibility;
  const value = normalizeLowercaseStringOrEmpty(raw);
  if (value === "self" || value === "tree" || value === "agent" || value === "all") {
    return value;
  }
  return "tree";
}

export function resolveEffectiveSessionToolsVisibility(params: {
  cfg: OpenClawConfig;
  sandboxed: boolean;
  agentTools?: { sessions?: { visibility?: string } };
}): SessionToolsVisibility {
  const visibility = resolveSessionToolsVisibility(params.cfg, params.agentTools);
  if (!params.sandboxed) {
    return visibility;
  }
  const sandboxClamp = params.cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
  if (sandboxClamp === "spawned" && visibility !== "tree") {
    return "tree";
  }
  return visibility;
}

export function resolveSandboxSessionToolsVisibility(cfg: OpenClawConfig): "spawned" | "all" {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

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
    !!requesterInternalKey &&
    !isSubagentSessionKey(requesterInternalKey);
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}

export function createAgentToAgentPolicy(
  cfg: OpenClawConfig,
  requesterAgentTools?: { agentToAgent?: { enabled?: boolean; allow?: string[] } },
): AgentToAgentPolicy {
  const globalA2A = cfg.tools?.agentToAgent;
  const perAgentA2A = requesterAgentTools?.agentToAgent;

  // Per-agent enabled overrides global (if explicitly set)
  const enabled = perAgentA2A?.enabled !== undefined
    ? perAgentA2A.enabled
    : (globalA2A?.enabled === true)

  // Per-agent allow overrides global allow (if explicitly set)
  const allowPatterns = Array.isArray(perAgentA2A?.allow)
    ? perAgentA2A.allow
    : Array.isArray(globalA2A?.allow) ? globalA2A.allow : []
  const matchesAllow = (agentId: string) => {
    if (allowPatterns.length === 0) {
      return true;
    }
    return allowPatterns.some((pattern) => {
      const raw =
        normalizeOptionalString(typeof pattern === "string" ? pattern : String(pattern ?? "")) ??
        "";
      if (!raw) {
        return false;
      }
      if (raw === "*") {
        return true;
      }
      if (!raw.includes("*")) {
        return raw === agentId;
      }
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "i");
      return re.test(agentId);
    });
  };
  const isAllowed = (requesterAgentId: string, targetAgentId: string) => {
    if (requesterAgentId === targetAgentId) {
      return true;
    }
    if (!enabled) {
      return false;
    }

    if (perAgentA2A?.allow !== undefined) {
      // Per-agent allow only restricts the TARGET; requester is implicitly trusted
      return matchesAllow(targetAgentId);
    }
    // Global: both sides must be on the mutual allowlist
    return matchesAllow(requesterAgentId) && matchesAllow(targetAgentId);
  };
  return { enabled, matchesAllow, isAllowed };
}

function actionPrefix(action: SessionAccessAction): string {
  if (action === "history") {
    return "Session history";
  }
  if (action === "send") {
    return "Session send";
  }
  if (action === "status") {
    return "Session status";
  }
  return "Session list";
}

function a2aDisabledMessage(action: SessionAccessAction): string {
  if (action === "history") {
    return "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.";
  }
  if (action === "send") {
    return "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.";
  }
  if (action === "status") {
    return "Agent-to-agent status is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.";
  }
  return "Agent-to-agent listing is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent visibility.";
}

function a2aDeniedMessage(action: SessionAccessAction): string {
  if (action === "history") {
    return "Agent-to-agent history denied by tools.agentToAgent.allow.";
  }
  if (action === "send") {
    return "Agent-to-agent messaging denied by tools.agentToAgent.allow.";
  }
  if (action === "status") {
    return "Agent-to-agent status denied by tools.agentToAgent.allow.";
  }
  return "Agent-to-agent listing denied by tools.agentToAgent.allow.";
}

function crossVisibilityMessage(action: SessionAccessAction): string {
  if (action === "history") {
    return "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
  }
  if (action === "send") {
    return "Session send visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
  }
  if (action === "status") {
    return "Session status visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
  }
  return "Session list visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
}

function selfVisibilityMessage(action: SessionAccessAction): string {
  return `${actionPrefix(action)} visibility is restricted to the current session (tools.sessions.visibility=self).`;
}

function treeVisibilityMessage(action: SessionAccessAction): string {
  return `${actionPrefix(action)} visibility is restricted to the current session tree (tools.sessions.visibility=tree).`;
}

export async function createSessionVisibilityGuard(params: {
  action: SessionAccessAction;
  requesterSessionKey: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
}): Promise<{
  check: (targetSessionKey: string) => SessionAccessResult;
}> {
  const requesterAgentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
  const spawnedKeys =
    params.visibility === "tree"
      ? await listSpawnedSessionKeys({ requesterSessionKey: params.requesterSessionKey })
      : null;

  const check = (targetSessionKey: string): SessionAccessResult => {
    const targetAgentId = resolveAgentIdFromSessionKey(targetSessionKey);
    const isCrossAgent = targetAgentId !== requesterAgentId;
    if (isCrossAgent) {
      if (params.visibility !== "all") {
        return {
          allowed: false,
          status: "forbidden",
          error: crossVisibilityMessage(params.action),
        };
      }
      if (!params.a2aPolicy.enabled) {
        return {
          allowed: false,
          status: "forbidden",
          error: a2aDisabledMessage(params.action),
        };
      }
      if (!params.a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
        return {
          allowed: false,
          status: "forbidden",
          error: a2aDeniedMessage(params.action),
        };
      }
      return { allowed: true };
    }

    if (params.visibility === "self" && targetSessionKey !== params.requesterSessionKey) {
      return {
        allowed: false,
        status: "forbidden",
        error: selfVisibilityMessage(params.action),
      };
    }

    if (
      params.visibility === "tree" &&
      targetSessionKey !== params.requesterSessionKey &&
      !spawnedKeys?.has(targetSessionKey)
    ) {
      return {
        allowed: false,
        status: "forbidden",
        error: treeVisibilityMessage(params.action),
      };
    }

    return { allowed: true };
  };

  return { check };
}
