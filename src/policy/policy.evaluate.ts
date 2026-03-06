import type { PolicyManagerState } from "./policy.manager.js";
import type { ConfigMutationAllowRule, SkillInstallAllowRule } from "./policy.schema.js";

export type PolicyEvaluationContext = {
  state: PolicyManagerState;
  nowMs?: number;
};

export type PolicyToolDecision = {
  allow: boolean;
  requireApproval?: boolean;
  reason?: string;
};

export type SkillInstallMeta = {
  skillId: string;
  version?: string;
  source?: string;
  installId?: string;
  kind?: string;
};

export type ConfigMutationPayload = {
  rawPatch?: unknown;
  nextConfig?: unknown;
  currentConfig?: unknown;
  changedPaths?: string[];
};

const DEFAULT_DANGEROUS_TOOL_PATTERNS = [
  "exec",
  "bash",
  "process",
  "browser",
  "web_fetch",
  "web_search",
  "gateway",
  "nodes",
  "sessions_spawn",
] as const;

const LOCKDOWN_DENY_TOOL_PATTERNS = [
  ...DEFAULT_DANGEROUS_TOOL_PATTERNS,
  "write",
  "edit",
  "apply_patch",
  "web_*",
  "browser_*",
  "fs_*",
] as const;

const CONFIG_MUTATION_ACTIONS = new Set([
  "config.set",
  "config.patch",
  "config.apply",
  "update.run",
  "gateway.restart",
]);

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizeToken(pattern);
  const normalizedValue = normalizeToken(value);
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern === "*") {
    return true;
  }
  if (normalizedPattern.endsWith("*")) {
    return normalizedValue.startsWith(normalizedPattern.slice(0, -1));
  }
  return normalizedPattern === normalizedValue;
}

function matchesAnyPattern(patterns: readonly string[] | undefined, value: string): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => matchesPattern(pattern, value));
}

function buildDangerousPatterns(state: PolicyManagerState): string[] {
  const merged = new Set<string>(DEFAULT_DANGEROUS_TOOL_PATTERNS);
  const configured = state.policy?.tools?.dangerous ?? [];
  for (const pattern of configured) {
    merged.add(pattern);
  }
  return [...merged];
}

function isDangerousTool(toolName: string, state: PolicyManagerState): boolean {
  return matchesAnyPattern(buildDangerousPatterns(state), toolName);
}

function isLockdownDeniedTool(toolName: string): boolean {
  return matchesAnyPattern(LOCKDOWN_DENY_TOOL_PATTERNS, toolName);
}

function resolveGatewayMutationAction(toolName: string, params: unknown): string | null {
  if (normalizeToken(toolName) !== "gateway") {
    return null;
  }
  if (!isRecord(params)) {
    return null;
  }
  const actionRaw = params.action;
  if (typeof actionRaw !== "string") {
    return null;
  }
  const action = normalizeToken(actionRaw);
  if (action === "restart") {
    return "gateway.restart";
  }
  if (action === "config.apply" || action === "config.patch" || action === "update.run") {
    return action;
  }
  return null;
}

function changedPathsFromPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const changed = payload.changedPaths;
  if (!Array.isArray(changed)) {
    return [];
  }
  return changed.filter((entry): entry is string => typeof entry === "string" && !!entry.trim());
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function mutationDisablesPolicy(payload: ConfigMutationPayload | undefined): boolean {
  if (!payload) {
    return false;
  }

  const current = payload.currentConfig;
  const currentEnabled =
    isRecord(current) && isRecord(current.policy) && current.policy.enabled === true;

  const next = payload.nextConfig;
  if (currentEnabled && isRecord(next)) {
    const nextPolicy = next.policy;
    if (!isRecord(nextPolicy) || nextPolicy.enabled !== true) {
      return true;
    }
  }

  const rawPatch = payload.rawPatch;
  if (currentEnabled && isRecord(rawPatch) && hasOwn(rawPatch, "policy")) {
    const patchPolicy = rawPatch.policy;
    if (!isRecord(patchPolicy)) {
      return true;
    }
    if (hasOwn(patchPolicy, "enabled") && patchPolicy.enabled !== true) {
      return true;
    }
  }
  return false;
}

function ruleMatchesChangedPaths(rule: ConfigMutationAllowRule, changedPaths: string[]): boolean {
  if (!rule.pathPrefixes || rule.pathPrefixes.length === 0 || changedPaths.length === 0) {
    return true;
  }
  return changedPaths.every((changedPath) =>
    rule.pathPrefixes?.some((prefix) => {
      const normalizedPrefix = normalizeToken(prefix);
      const normalizedPath = normalizeToken(changedPath);
      return (
        normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}.`)
      );
    }),
  );
}

function matchesSkillInstallRule(rule: SkillInstallAllowRule, meta: SkillInstallMeta): boolean {
  if (!matchesPattern(rule.skillId, meta.skillId)) {
    return false;
  }
  if (rule.version && !matchesPattern(rule.version, meta.version ?? "")) {
    return false;
  }
  if (rule.source && !matchesPattern(rule.source, meta.source ?? "")) {
    return false;
  }
  if (rule.installId && !matchesPattern(rule.installId, meta.installId ?? "")) {
    return false;
  }
  if (rule.kind && !matchesPattern(rule.kind, meta.kind ?? "")) {
    return false;
  }
  return true;
}

export function evaluateToolCall(
  toolName: string,
  params: unknown,
  ctx: PolicyEvaluationContext,
): PolicyToolDecision {
  const normalizedToolName = normalizeToken(toolName);
  const state = ctx.state;

  if (!state.enabled) {
    return { allow: true };
  }

  if (state.lockdown) {
    if (isLockdownDeniedTool(normalizedToolName)) {
      return {
        allow: false,
        reason: `policy lockdown active: ${state.reason ?? "policy signature invalid or missing"}`,
      };
    }
    return { allow: true };
  }

  if (!state.valid || !state.policy) {
    return { allow: true };
  }

  const gatewayMutationAction = resolveGatewayMutationAction(normalizedToolName, params);
  if (gatewayMutationAction) {
    const mutationDecision = evaluateConfigMutation(gatewayMutationAction, undefined, ctx);
    if (!mutationDecision.allow) {
      return mutationDecision;
    }
    if (mutationDecision.requireApproval) {
      return {
        allow: true,
        requireApproval: true,
        reason: mutationDecision.reason,
      };
    }
  }

  if (matchesAnyPattern(state.policy.tools?.deny, normalizedToolName)) {
    return {
      allow: false,
      reason: `tool "${normalizedToolName}" is explicitly denied by policy`,
    };
  }

  const dangerous = isDangerousTool(normalizedToolName, state);
  if (dangerous && !matchesAnyPattern(state.policy.tools?.allow, normalizedToolName)) {
    return {
      allow: false,
      reason: `dangerous tool "${normalizedToolName}" is not allowlisted`,
    };
  }

  if (matchesAnyPattern(state.policy.tools?.requireApproval, normalizedToolName)) {
    return {
      allow: true,
      requireApproval: true,
      reason: `tool "${normalizedToolName}" requires policy approval`,
    };
  }

  return { allow: true };
}

export function evaluateSkillInstall(
  meta: SkillInstallMeta,
  ctx: PolicyEvaluationContext,
): { allow: boolean; reason?: string } {
  const state = ctx.state;
  if (!state.enabled) {
    return { allow: true };
  }
  if (state.lockdown) {
    return {
      allow: false,
      reason: `policy lockdown active: ${state.reason ?? "policy signature invalid or missing"}`,
    };
  }
  if (!state.valid || !state.policy) {
    return { allow: true };
  }
  const rules = state.policy.skillInstalls?.allow ?? [];
  if (rules.length === 0) {
    return {
      allow: false,
      reason: `skill install "${meta.skillId}" denied (no allowlisted install rules)`,
    };
  }
  if (rules.some((rule) => matchesSkillInstallRule(rule, meta))) {
    return { allow: true };
  }
  return {
    allow: false,
    reason: `skill install "${meta.skillId}" denied by policy allowlist`,
  };
}

export function evaluateConfigMutation(
  action: string,
  patch: ConfigMutationPayload | undefined,
  ctx: PolicyEvaluationContext,
): PolicyToolDecision {
  const normalizedAction = normalizeToken(action);
  const state = ctx.state;
  if (!state.enabled) {
    return { allow: true };
  }
  if (state.lockdown) {
    return {
      allow: false,
      reason: `policy lockdown active: ${state.reason ?? "policy signature invalid or missing"}`,
    };
  }
  if (!state.valid || !state.policy) {
    return { allow: true };
  }

  if (!CONFIG_MUTATION_ACTIONS.has(normalizedAction)) {
    return { allow: true };
  }

  const rules = state.policy.configMutations?.allow ?? [];
  if (rules.length === 0) {
    return {
      allow: false,
      reason: `config mutation "${normalizedAction}" denied (no allowlisted mutation rules)`,
    };
  }

  const disableAttempt = mutationDisablesPolicy(patch);
  const changedPaths = changedPathsFromPayload(patch);

  for (const rule of rules) {
    if (!matchesPattern(rule.action, normalizedAction)) {
      continue;
    }
    if (!ruleMatchesChangedPaths(rule, changedPaths)) {
      continue;
    }
    if (disableAttempt && rule.allowPolicyDisable !== true) {
      continue;
    }
    if (disableAttempt && rule.requireApproval !== true) {
      return {
        allow: false,
        reason: 'policy.enabled disable attempt requires "requireApproval": true',
      };
    }
    return {
      allow: true,
      requireApproval: rule.requireApproval === true,
      reason:
        disableAttempt && rule.requireApproval === true
          ? "policy disable mutation requires explicit approval"
          : undefined,
    };
  }

  if (disableAttempt) {
    return {
      allow: false,
      reason: "policy.enabled disable attempt denied (missing allowPolicyDisable rule)",
    };
  }
  return {
    allow: false,
    reason: `config mutation "${normalizedAction}" denied by policy allowlist`,
  };
}
