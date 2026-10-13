import type { Result } from "@openclaw/normalization-core/result";
// Session visibility helpers decide which plugin sessions appear in user-facing lists.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import { listAgentEntries } from "../agents/agent-roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import {
  createSessionVisibilityDecisionChecker,
  listSpawnedSessionKeysWithResult,
  logSessionOwnershipLookupFailure,
  renderSessionVisibilityDenial,
  resolveIncognitoSessionAccessDecision,
  sessionOwnershipLookupDenied,
  type SessionVisibilityDecisionAction,
  type SessionVisibilityDecisionMode,
  type SessionVisibilityDecisionPolicy,
  type SessionVisibilityDecisionRow,
  type SessionVisibilityDecision,
  type SessionOwnershipLookupFailure,
} from "./session-visibility-internal.js";

type GatewayCaller = typeof defaultCallGateway;

/** Configured visibility mode for session tools and session-related commands. */
export type SessionToolsVisibility = SessionVisibilityDecisionMode;

/** Agent-to-agent access policy compiled from `tools.agentToAgent` config. */
export type AgentToAgentPolicy = SessionVisibilityDecisionPolicy & {
  matchesAllow: (agentId: string) => boolean;
};

/** Session operation to authorize; send-only grants never apply to read/status actions. */
export type SessionAccessAction = SessionVisibilityDecisionAction;

/** Result of checking whether one session operation may target a session. */
export type SessionAccessResult =
  | { allowed: true; expectedSessionId?: string }
  | { allowed: false; error: string; status: "forbidden" };

type ScopedSessionAccessRequest = {
  action: Exclude<SessionAccessAction, "list">;
  requesterSessionKey: string;
  targetSessionKey: string;
};

type ScopedSessionAccessGrant = { expectedSessionId: string };

type ScopedSessionAccessProvider = (
  request: ScopedSessionAccessRequest,
) => ScopedSessionAccessGrant | undefined;

type ScopedSessionAccessRegistration = {
  provider: ScopedSessionAccessProvider;
  resolveAsync?: (
    request: ScopedSessionAccessRequest,
  ) => Promise<ScopedSessionAccessGrant | undefined>;
};

const scopedSessionAccessProviders = new Map<
  ScopedSessionAccessProvider,
  ScopedSessionAccessRegistration
>();

function registerScopedSessionAccessProvider(
  provider: ScopedSessionAccessProvider,
  options?: Pick<ScopedSessionAccessRegistration, "resolveAsync">,
): () => void {
  const registration = { provider, resolveAsync: options?.resolveAsync };
  scopedSessionAccessProviders.set(provider, registration);
  return () => {
    if (scopedSessionAccessProviders.get(provider) === registration) {
      scopedSessionAccessProviders.delete(provider);
    }
  };
}

function resolveScopedSessionAccess(
  request: ScopedSessionAccessRequest,
): ScopedSessionAccessGrant | undefined {
  // Incognito transcripts must never be re-persisted through another session,
  // including host-scoped access paths that bypass normal visibility policy.
  if (resolveIncognitoSessionAccessDecision(request.targetSessionKey)) {
    return undefined;
  }
  for (const provider of scopedSessionAccessProviders.keys()) {
    try {
      const grant = provider(request);
      const expectedSessionId = normalizeOptionalString(grant?.expectedSessionId);
      if (expectedSessionId) {
        return { expectedSessionId };
      }
    } catch {
      // Access providers fail closed; normal visibility evaluation still runs.
    }
  }
  return undefined;
}

async function resolveScopedSessionAccessAsync(
  request: ScopedSessionAccessRequest,
): Promise<ScopedSessionAccessGrant | undefined> {
  if (resolveIncognitoSessionAccessDecision(request.targetSessionKey)) {
    return undefined;
  }
  // A replacement registration cannot authorize work admitted by its predecessor.
  const registrations = [...scopedSessionAccessProviders.values()];
  for (const registration of registrations) {
    const { provider, resolveAsync } = registration;
    if (scopedSessionAccessProviders.get(provider) !== registration) {
      continue;
    }
    try {
      const grant = await (resolveAsync ?? provider)(request);
      const expectedSessionId = normalizeOptionalString(grant?.expectedSessionId);
      if (expectedSessionId && scopedSessionAccessProviders.get(provider) === registration) {
        return { expectedSessionId };
      }
    } catch {
      // Do not retry a declined async decision through its synchronous companion.
    }
  }
  return undefined;
}

/** Minimal session row metadata needed to evaluate ownership and cross-agent access. */
export type SessionVisibilityRow = SessionVisibilityDecisionRow;

/** Resolve configured session-tool visibility, defaulting invalid or missing values to all. */
export function resolveSessionToolsVisibility(cfg: OpenClawConfig): SessionToolsVisibility {
  const value = normalizeLowercaseStringOrEmpty(cfg.tools?.sessions?.visibility);
  if (value === "self" || value === "tree" || value === "agent" || value === "all") {
    return value;
  }
  return "all";
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
  return resolveSandboxSessionToolsVisibility(params.cfg) === "spawned" ? "tree" : visibility;
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
  if (!lower.startsWith(pattern.first)) {
    return false;
  }
  let pos = pattern.first.length;

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

function compileAgentAllowMatcher(patterns: string[]): (agentId: string) => boolean {
  const allowPatterns = patterns.map(compileAgentAllowPattern);
  const hasWildcardPatterns = allowPatterns.some((pattern) => pattern.kind === "wildcard");
  return (agentId: string) => {
    const lowerAgentId = hasWildcardPatterns ? agentId.toLowerCase() : "";
    return allowPatterns.some((pattern) => {
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
}

/** Compile participation and independent outbound-send rules; reads never use send grants. */
export function createAgentToAgentPolicy(
  cfg: OpenClawConfig,
  options?: { sandboxed?: boolean },
): AgentToAgentPolicy {
  const enabled = cfg.tools?.agentToAgent?.enabled !== false;
  const allow = cfg.tools?.agentToAgent?.allow;
  // The shipped global empty list is unrestricted; explicit per-agent [] instead denies sends.
  const matchesAllow = allow?.length ? compileAgentAllowMatcher(allow) : () => true;
  return {
    enabled,
    matchesAllow,
    isAllowed: (requester, target) =>
      requester === target || (enabled && matchesAllow(requester) && matchesAllow(target)),
    resolveSendAccess: (requester, target) => {
      if (options?.sandboxed && resolveSandboxSessionToolsVisibility(cfg) === "spawned") {
        return undefined;
      }
      // Reads never traverse the fleet; sends compile only the requester's destinations.
      const send = listAgentEntries(cfg).find(
        (entry) => normalizeLowercaseStringOrEmpty(entry.id) === requester,
      )?.tools?.agentToAgent?.send;
      return send ? compileAgentAllowMatcher(send)(target) : undefined;
    },
  };
}

function toSessionAccessResult(
  decision: SessionVisibilityDecision,
  action: SessionAccessAction,
  targetSessionKey: string,
): SessionAccessResult {
  return decision.allowed
    ? decision
    : {
        allowed: false,
        status: "forbidden",
        error: renderSessionVisibilityDenial(decision, { action, targetSessionKey }),
      };
}

type SessionVisibilityCheckerParams = {
  action: SessionAccessAction;
  defaultAgentId?: string;
  requesterAgentId?: string;
  requesterSessionKey: string;
  mainSessionKey?: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
};

function createSessionVisibilityCheckerWithResult(
  params: SessionVisibilityCheckerParams & {
    spawnedKeys: Result<Set<string>, SessionOwnershipLookupFailure> | null;
  },
): { check: (targetSessionKey: string) => SessionAccessResult } {
  const spawnedKeys = params.spawnedKeys;
  let lookupFailureLogged = false;
  const decisionChecker = createSessionVisibilityDecisionChecker(params);

  const check = (targetSessionKey: string): SessionAccessResult => {
    const incognitoDenial = resolveIncognitoSessionAccessDecision(targetSessionKey);
    if (incognitoDenial) {
      return toSessionAccessResult(incognitoDenial, params.action, targetSessionKey);
    }
    if (params.action !== "list") {
      const scoped = resolveScopedSessionAccess({
        action: params.action,
        requesterSessionKey: params.requesterSessionKey,
        targetSessionKey,
      });
      if (scoped) {
        return { allowed: true, expectedSessionId: scoped.expectedSessionId };
      }
    }
    const spawnedKeySet = spawnedKeys?.ok ? spawnedKeys.value : undefined;
    const isSpawnedSession = spawnedKeySet?.has(targetSessionKey) === true;
    const result = decisionChecker.check({
      key: targetSessionKey,
      spawnedBy: isSpawnedSession ? params.requesterSessionKey : undefined,
    });
    if (!result.allowed) {
      const ownedResult = decisionChecker.check({
        key: targetSessionKey,
        spawnedBy: params.requesterSessionKey,
      });
      // Preserve denials that ownership cannot change; only ownership-dependent
      // denials should be replaced by lookup-failure guidance.
      const lookupFailed =
        spawnedKeys !== null &&
        !spawnedKeys.ok &&
        targetSessionKey !== params.requesterSessionKey &&
        targetSessionKey !== "current" &&
        ownedResult.allowed;
      if (lookupFailed) {
        if (!lookupFailureLogged) {
          lookupFailureLogged = true;
          logSessionOwnershipLookupFailure({
            requesterSessionKey: params.requesterSessionKey,
            failure: spawnedKeys.error,
          });
        }
        return toSessionAccessResult(
          sessionOwnershipLookupDenied(spawnedKeys.error.kind),
          params.action,
          targetSessionKey,
        );
      }
    }
    return toSessionAccessResult(result, params.action, targetSessionKey);
  };

  return { check };
}

/** Create a direct session-key visibility checker for one requester/action pair. */
function createSessionVisibilityCheckerImpl(
  params: SessionVisibilityCheckerParams & { spawnedKeys: Set<string> | null },
): { check: (targetSessionKey: string) => SessionAccessResult } {
  return createSessionVisibilityCheckerWithResult({
    ...params,
    spawnedKeys: params.spawnedKeys ? { ok: true, value: params.spawnedKeys } : null,
  });
}

/** Direct-key visibility checker plus registration for narrow host-owned grants. */
export const createSessionVisibilityChecker = Object.assign(createSessionVisibilityCheckerImpl, {
  registerScopedAccessProvider: registerScopedSessionAccessProvider,
  resolveScopedAccess: resolveScopedSessionAccess,
  resolveScopedAccessAsync: resolveScopedSessionAccessAsync,
});

/** Create a row-aware visibility checker that can use owner/spawn metadata. */
export function createSessionVisibilityRowChecker(params: SessionVisibilityCheckerParams): {
  check: (row: SessionVisibilityRow) => SessionAccessResult;
} {
  const checker = createSessionVisibilityDecisionChecker(params);
  return {
    check: (row) => toSessionAccessResult(checker.check(row), params.action, row.key),
  };
}

/** Create a visibility guard, loading spawned-session ownership when direct keys need it. */
export async function createSessionVisibilityGuard(
  params: SessionVisibilityCheckerParams & { callGateway?: GatewayCaller },
): Promise<{
  check: (targetSessionKey: string) => SessionAccessResult;
}> {
  // Listing already has row ownership metadata; direct key actions still need
  // this lookup until every caller can pass a normalized session row.
  const spawnedKeys =
    params.action !== "list" && (params.visibility === "tree" || params.visibility === "all")
      ? await listSpawnedSessionKeysWithResult({
          requesterSessionKey: params.requesterSessionKey,
          callGateway: params.callGateway,
        })
      : null;
  return createSessionVisibilityCheckerWithResult({ ...params, spawnedKeys });
}
