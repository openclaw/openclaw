import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway as defaultCallGateway } from "../gateway/call.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

type GatewayCaller = typeof defaultCallGateway;

let callGatewayForListSpawned: GatewayCaller = defaultCallGateway;

/** Test hook: must stay aligned with `sessions-resolution` `__testing.setDepsForTest`. */
export const sessionVisibilityGatewayTesting = {
  setCallGatewayForListSpawned(overrides?: GatewayCaller) {
    callGatewayForListSpawned = overrides ?? defaultCallGateway;
  },
};

export type SessionToolsVisibility = "self" | "tree" | "agent" | "all";

export type AgentToAgentDenyReason = "disabled" | "global_participation" | "per_agent_outbound";

export type AgentToAgentDecision =
  | { allowed: true }
  | { allowed: false; reason: AgentToAgentDenyReason };

export type AgentToAgentPolicy = {
  enabled: boolean;
  matchesGlobalParticipation: (agentId: string) => boolean;
  matchesAllow: (agentId: string) => boolean;
  evaluateAccess: (requesterAgentId: string, targetAgentId: string) => AgentToAgentDecision;
  isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};

export type SessionAccessAction = "history" | "send" | "list" | "status";

export type SessionAccessResult =
  | { allowed: true }
  | { allowed: false; error: string; status: "forbidden" };

export async function listSpawnedSessionKeys(params: {
  requesterSessionKey: string;
  limit?: number;
}): Promise<Set<string>> {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : undefined;
  try {
    const list = await callGatewayForListSpawned<{ sessions: Array<{ key?: unknown }> }>({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        ...(limit !== undefined ? { limit } : {}),
        spawnedBy: params.requesterSessionKey,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const keys = sessions.map((entry) => normalizeOptionalString(entry?.key) ?? "").filter(Boolean);
    return new Set(keys);
  } catch {
    return new Set();
  }
}

export function resolveSessionToolsVisibility(cfg: OpenClawConfig): SessionToolsVisibility {
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

export function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy {
  const routingA2A = cfg.tools?.agentToAgent;
  const enabled = routingA2A?.enabled === true;
  const allowPatterns = Array.isArray(routingA2A?.allow) ? routingA2A.allow : [];
  const matchesPatterns = (patterns: string[], agentId: string) => {
    const normalizedAgentId = normalizeAgentId(agentId);
    return patterns.some((pattern) => {
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
        return normalizeAgentId(raw) === normalizedAgentId;
      }
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "i");
      return re.test(agentId);
    });
  };
  const matchesGlobalParticipation = (agentId: string) => {
    if (allowPatterns.length === 0) {
      return true;
    }
    return matchesPatterns(allowPatterns, agentId);
  };
  const resolvePerAgentOutboundAllow = (agentId: string): string[] | undefined => {
    const normalizedAgentId = normalizeAgentId(agentId);
    const agent = cfg.agents?.list?.find(
      (entry) => normalizeAgentId(entry.id) === normalizedAgentId,
    );
    const allow = agent?.tools?.agentToAgent?.allow;
    return Array.isArray(allow) ? allow : undefined;
  };
  const evaluateAccess = (
    requesterAgentId: string,
    targetAgentId: string,
  ): AgentToAgentDecision => {
    const requester = normalizeAgentId(requesterAgentId);
    const target = normalizeAgentId(targetAgentId);
    if (requester === target) {
      return { allowed: true };
    }
    if (!enabled) {
      return { allowed: false, reason: "disabled" };
    }
    if (!matchesGlobalParticipation(requester) || !matchesGlobalParticipation(target)) {
      return { allowed: false, reason: "global_participation" };
    }
    const outboundAllow = resolvePerAgentOutboundAllow(requester);
    if (outboundAllow !== undefined) {
      if (outboundAllow.length === 0 || !matchesPatterns(outboundAllow, target)) {
        return { allowed: false, reason: "per_agent_outbound" };
      }
    }
    return { allowed: true };
  };
  const isAllowed = (requesterAgentId: string, targetAgentId: string) => {
    return evaluateAccess(requesterAgentId, targetAgentId).allowed;
  };
  return {
    enabled,
    matchesGlobalParticipation,
    matchesAllow: matchesGlobalParticipation,
    evaluateAccess,
    isAllowed,
  };
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

function a2aDeniedMessage(
  action: SessionAccessAction,
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
    return `Agent-to-agent status denied by ${configPath}.`;
  }
  return `Agent-to-agent listing denied by ${configPath}.`;
}

export function formatAgentToAgentAccessError(
  action: SessionAccessAction,
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

export function createSessionVisibilityChecker(params: {
  action: SessionAccessAction;
  requesterSessionKey: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
  spawnedKeys: Set<string> | null;
}): { check: (targetSessionKey: string) => SessionAccessResult } {
  const requesterAgentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
  const spawnedKeys = params.spawnedKeys;

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

export async function createSessionVisibilityGuard(params: {
  action: SessionAccessAction;
  requesterSessionKey: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
}): Promise<{
  check: (targetSessionKey: string) => SessionAccessResult;
}> {
  const spawnedKeys =
    params.visibility === "tree"
      ? await listSpawnedSessionKeys({ requesterSessionKey: params.requesterSessionKey })
      : null;
  return createSessionVisibilityChecker({
    action: params.action,
    requesterSessionKey: params.requesterSessionKey,
    visibility: params.visibility,
    a2aPolicy: params.a2aPolicy,
    spawnedKeys,
  });
}
