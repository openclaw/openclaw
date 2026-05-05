// Session visibility helpers decide which plugin sessions appear in user-facing lists.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway as defaultCallGateway } from "../gateway/call.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";

type GatewayCaller = typeof defaultCallGateway;

let callGatewayForListSpawned: GatewayCaller = defaultCallGateway;

/** Test hook: must stay aligned with `sessions-resolution` `testing.setDepsForTest`. */
export const sessionVisibilityGatewayTesting = {
  setCallGatewayForListSpawned(overrides?: GatewayCaller) {
    callGatewayForListSpawned = overrides ?? defaultCallGateway;
  },
};

/** Configured visibility mode for session tools and session-related commands. */
export type SessionToolsVisibility = "self" | "tree" | "agent" | "all";

/** Agent-to-agent access policy compiled from `tools.agentToAgent` config. */
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

/** Session operation whose visibility error copy should be rendered. */
export type SessionAccessAction = "history" | "send" | "list" | "status";

/** Result of checking whether one session operation may target a session. */
export type SessionAccessResult =
  | { allowed: true }
  | { allowed: false; error: string; status: "forbidden" };

/** Minimal session row metadata needed to evaluate ownership and cross-agent access. */
export type SessionVisibilityRow = {
  key: string;
  agentId?: string;
  ownerSessionKey?: string;
  spawnedBy?: string;
  parentSessionKey?: string;
};

/** List sessions spawned by the requester through the gateway session list method. */
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
    const keys = normalizeTrimmedStringList(sessions.map((entry) => entry?.key));
    return new Set(keys);
  } catch {
    return new Set();
  }
}

/** Resolve configured session-tool visibility, defaulting invalid or missing values to tree. */
export function resolveSessionToolsVisibility(cfg: OpenClawConfig): SessionToolsVisibility {
  const raw = (cfg.tools as { sessions?: { visibility?: unknown } } | undefined)?.sessions
    ?.visibility;
  const value = normalizeLowercaseStringOrEmpty(raw);
  if (value === "self" || value === "tree" || value === "agent" || value === "all") {
    return value;
  }
  return "tree";
}

/** Resolve visibility after applying sandbox clamps for spawned-session-only agents. */
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

/** Resolve sandbox-specific session visibility clamp for agent defaults. */
export function resolveSandboxSessionToolsVisibility(cfg: OpenClawConfig): "spawned" | "all" {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

type CompiledAgentAllowPattern =
  | { kind: "all" }
  | { kind: "deny" }
  | { kind: "exact"; value: string }
  | {
      kind: "wildcard";
      first: string;
      last: string;
      interior: string[];
    };

function compileAgentAllowPattern(pattern: string): CompiledAgentAllowPattern {
  const raw = normalizeOptionalString(pattern) ?? "";
  if (!raw) {
    return { kind: "deny" };
  }
  if (raw === "*") {
    return { kind: "all" };
  }
  if (!raw.includes("*")) {
    return { kind: "exact", value: raw };
  }
  const parts = raw.toLowerCase().split("*");
  return {
    kind: "wildcard",
    first: parts[0] ?? "",
    last: parts[parts.length - 1] ?? "",
    interior: parts.slice(1, -1).filter(Boolean),
  };
}

/**
 * Linear-time case-insensitive glob matcher for precompiled `*` patterns.
 * Checks prefix, suffix, then ordered interior segments without entering the
 * regex engine, avoiding polynomial backtracking on repeated wildcards.
 */
function matchesCompiledWildcard(
  pattern: Extract<CompiledAgentAllowPattern, { kind: "wildcard" }>,
  lower: string,
): boolean {
  let pos = 0;
  if (pattern.first) {
    if (!lower.startsWith(pattern.first)) {
      return false;
    }
    pos = pattern.first.length;
  }

  const endBound = pattern.last ? lower.length - pattern.last.length : lower.length;
  if (pattern.last && (!lower.endsWith(pattern.last) || endBound < pos)) {
    return false;
  }

  for (const part of pattern.interior) {
    const idx = lower.indexOf(part, pos);
    if (idx === -1 || idx + part.length > endBound) {
      return false;
    }
    pos = idx + part.length;
  }

  return true;
}

/** Compile agent-to-agent allow rules into reusable matching predicates. */
export function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy {
  const routingA2A = cfg.tools?.agentToAgent;
  const enabled = routingA2A?.enabled === true;
  const compilePatterns = (patterns: string[]): CompiledAgentAllowPattern[] =>
    patterns.map((pattern) => compileAgentAllowPattern(pattern));
  const matchesPatterns = (patterns: CompiledAgentAllowPattern[], agentId: string) => {
    const hasWildcardPatterns = patterns.some((pattern) => pattern.kind === "wildcard");
    const lowerAgentId = hasWildcardPatterns ? agentId.toLowerCase() : "";
    return patterns.some((pattern) => {
      if (pattern.kind === "all") {
        return true;
      }
      if (pattern.kind === "deny") {
        return false;
      }
      if (pattern.kind === "exact") {
        return pattern.value === agentId;
      }
      return matchesCompiledWildcard(pattern, lowerAgentId);
    });
  };
  const rawAllowPatterns = Array.isArray(routingA2A?.allow) ? routingA2A.allow : [];
  const allowPatterns = compilePatterns(rawAllowPatterns);
  const matchesGlobalParticipation = (agentId: string) => {
    if (allowPatterns.length === 0) {
      return true;
    }
    return matchesPatterns(allowPatterns, agentId);
  };
  const resolvePerAgentOutboundAllow = (
    agentId: string,
  ): CompiledAgentAllowPattern[] | undefined => {
    const normalizedAgentId = normalizeAgentId(agentId);
    const agent = cfg.agents?.list?.find(
      (entry) => normalizeAgentId(entry.id) === normalizedAgentId,
    );
    const allow = agent?.tools?.agentToAgent?.allow;
    return Array.isArray(allow) ? compilePatterns(allow) : undefined;
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
    if (
      !matchesGlobalParticipation(requesterAgentId) ||
      !matchesGlobalParticipation(targetAgentId)
    ) {
      return { allowed: false, reason: "global_participation" };
    }
    const outboundAllow = resolvePerAgentOutboundAllow(requester);
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
  const suffix =
    "Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.";
  if (action === "history") {
    return `Session history visibility is restricted. ${suffix}`;
  }
  if (action === "send") {
    return `Session send visibility is restricted. ${suffix}`;
  }
  if (action === "status") {
    return `Session status visibility is restricted. ${suffix}`;
  }
  return `Session list visibility is restricted. ${suffix}`;
}

function selfVisibilityMessage(action: SessionAccessAction): string {
  return `${actionPrefix(action)} visibility is restricted to the current session (tools.sessions.visibility=self).`;
}

function treeVisibilityMessage(action: SessionAccessAction): string {
  return `${actionPrefix(action)} visibility is restricted to the current session tree (tools.sessions.visibility=tree).`;
}

/** Create a direct session-key visibility checker for one requester/action pair. */
export function createSessionVisibilityChecker(params: {
  action: SessionAccessAction;
  requesterSessionKey: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
  spawnedKeys: Set<string> | null;
}): { check: (targetSessionKey: string) => SessionAccessResult } {
  const spawnedKeys = params.spawnedKeys;
  const rowChecker = createSessionVisibilityRowChecker({
    action: params.action,
    requesterSessionKey: params.requesterSessionKey,
    visibility: params.visibility,
    a2aPolicy: params.a2aPolicy,
  });

  const check = (targetSessionKey: string): SessionAccessResult => {
    const isSpawnedSession = spawnedKeys?.has(targetSessionKey) === true;
    return rowChecker.check({
      key: targetSessionKey,
      spawnedBy: isSpawnedSession ? params.requesterSessionKey : undefined,
    });
  };

  return { check };
}

function rowOwnedByRequester(row: SessionVisibilityRow, requesterSessionKey: string): boolean {
  return (
    row.ownerSessionKey === requesterSessionKey ||
    row.spawnedBy === requesterSessionKey ||
    row.parentSessionKey === requesterSessionKey
  );
}

/** Create a row-aware visibility checker that can use owner/spawn metadata. */
export function createSessionVisibilityRowChecker(params: {
  action: SessionAccessAction;
  requesterSessionKey: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
}): { check: (row: SessionVisibilityRow) => SessionAccessResult } {
  const requesterAgentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);

  const check = (row: SessionVisibilityRow): SessionAccessResult => {
    const targetSessionKey = row.key;
    const targetAgentId = row.agentId ?? resolveAgentIdFromSessionKey(targetSessionKey);
    const isRequesterSession =
      targetSessionKey === params.requesterSessionKey || targetSessionKey === "current";
    const isRequesterOwned = rowOwnedByRequester(row, params.requesterSessionKey);
    // Row ownership is stronger than agent ids: ACP children may use a backend
    // agent id while still belonging to the requester that spawned them.
    if (
      !isRequesterSession &&
      isRequesterOwned &&
      (params.visibility === "tree" || params.visibility === "all")
    ) {
      return { allowed: true };
    }
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

    if (params.visibility === "self" && !isRequesterSession) {
      return {
        allowed: false,
        status: "forbidden",
        error: selfVisibilityMessage(params.action),
      };
    }

    if (params.visibility === "tree" && !isRequesterSession && !isRequesterOwned) {
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

/** Create a visibility guard, loading spawned-session ownership when direct keys need it. */
export async function createSessionVisibilityGuard(params: {
  action: SessionAccessAction;
  requesterSessionKey: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
}): Promise<{
  check: (targetSessionKey: string) => SessionAccessResult;
}> {
  // Listing already has row ownership metadata; direct key actions still need
  // this lookup until every caller can pass a normalized session row.
  const spawnedKeys =
    params.action !== "list" && (params.visibility === "tree" || params.visibility === "all")
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
