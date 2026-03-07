import type { OpenClawConfig } from "../../config/config.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  listSpawnedSessionKeys,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-resolution.js";

export type SessionToolsVisibility = "self" | "tree" | "agent" | "all";

export type AgentToAgentDenyReason = "disabled" | "global_participation" | "per_agent_outbound";

export type AgentToAgentDecision =
  | { allowed: true }
  | { allowed: false; reason: AgentToAgentDenyReason };

export type AgentToAgentPolicy = {
  enabled: boolean;
  matchesGlobalParticipation: (agentId: string) => boolean;
  evaluateAccess: (requesterAgentId: string, targetAgentId: string) => AgentToAgentDecision;
  isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};

export type SessionAccessAction = "history" | "send" | "list";
export type AgentToAgentAction = SessionAccessAction | "status";

export type SessionAccessResult =
  | { allowed: true }
  | { allowed: false; error: string; status: "forbidden" };

export function resolveSessionToolsVisibility(cfg: OpenClawConfig): SessionToolsVisibility {
  const raw = (cfg.tools as { sessions?: { visibility?: unknown } } | undefined)?.sessions
    ?.visibility;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "self" || value === "tree" || value === "agent" || value === "all") {
    return value;
  }
  return "tree";
}

export function resolveEffectiveSessionToolsVisibility(params: {
  cfg: OpenClawConfig;
  sandboxed: boolean;
}): SessionToolsVisibility {
  const visibility = resolveSessionToolsVisibility(params.cfg);
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
  const requesterInternalKey =
    typeof params.agentSessionKey === "string" && params.agentSessionKey.trim()
      ? resolveInternalSessionKey({
          key: params.agentSessionKey,
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

export function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy {
  const globalA2A = cfg.tools?.agentToAgent;
  const enabled = globalA2A?.enabled === true;
  const globalAllow = Array.isArray(globalA2A?.allow) ? globalA2A.allow : [];
  const matchesPatterns = (patterns: string[], agentId: string) =>
    patterns.some((pattern) => {
      const raw = String(pattern ?? "").trim();
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
  const matchesGlobalParticipation = (agentId: string) => {
    if (globalAllow.length === 0) {
      return true;
    }
    return matchesPatterns(globalAllow, agentId);
  };
  const resolveOutboundAllow = (agentId: string): string[] | undefined => {
    const allow = resolveAgentConfig(cfg, agentId)?.tools?.agentToAgent?.allow;
    return Array.isArray(allow) ? allow : undefined;
  };
  const evaluateAccess = (
    requesterAgentId: string,
    targetAgentId: string,
  ): AgentToAgentDecision => {
    if (requesterAgentId === targetAgentId) {
      return { allowed: true };
    }
    if (!enabled) {
      return { allowed: false, reason: "disabled" };
    }
    if (
      !matchesGlobalParticipation(requesterAgentId) ||
      !matchesGlobalParticipation(targetAgentId)
    ) {
      return { allowed: false, reason: "global_participation" };
    }
    const outboundAllow = resolveOutboundAllow(requesterAgentId);
    if (outboundAllow !== undefined) {
      if (outboundAllow.length === 0 || !matchesPatterns(outboundAllow, targetAgentId)) {
        return { allowed: false, reason: "per_agent_outbound" };
      }
    }
    return { allowed: true };
  };
  const isAllowed = (requesterAgentId: string, targetAgentId: string) => {
    return evaluateAccess(requesterAgentId, targetAgentId).allowed;
  };
  return { enabled, matchesGlobalParticipation, evaluateAccess, isAllowed };
}

function actionPrefix(action: SessionAccessAction): string {
  if (action === "history") {
    return "Session history";
  }
  if (action === "send") {
    return "Session send";
  }
  return "Session list";
}

function a2aDisabledMessage(action: AgentToAgentAction): string {
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

function a2aDeniedMessage(
  action: AgentToAgentAction,
  reason: Exclude<AgentToAgentDenyReason, "disabled">,
): string {
  const configPath =
    reason === "per_agent_outbound"
      ? "agents.list[].tools.agentToAgent.allow for the requester agent"
      : "tools.agentToAgent.allow";
  if (action === "history") {
    return `Agent-to-agent history denied by ${configPath}.`;
  }
  if (action === "send") {
    return `Agent-to-agent messaging denied by ${configPath}.`;
  }
  if (action === "status") {
    return `Agent-to-agent session status denied by ${configPath}.`;
  }
  return `Agent-to-agent listing denied by ${configPath}.`;
}

export function formatAgentToAgentAccessError(
  action: AgentToAgentAction,
  decision: Extract<AgentToAgentDecision, { allowed: false }>,
): string {
  if (decision.reason === "disabled") {
    return a2aDisabledMessage(action);
  }
  return a2aDeniedMessage(action, decision.reason);
}

function crossVisibilityMessage(action: SessionAccessAction): string {
  if (action === "history") {
    return "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
  }
  if (action === "send") {
    return "Session send visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
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
      const a2aDecision = params.a2aPolicy.evaluateAccess(requesterAgentId, targetAgentId);
      if (!a2aDecision.allowed) {
        return {
          allowed: false,
          status: "forbidden",
          error: formatAgentToAgentAccessError(params.action, a2aDecision),
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
