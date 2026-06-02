import { normalizeToolList, normalizeToolName } from "./tool-policy.js";

export type TurnSurfacePolicy = {
  enabled: boolean;
  toolsAllow?: string[];
  excludeToolNames: string[];
  defaultDenyEnabled: boolean;
};

const DEFAULT_SCOPE_DENY_TOOL_NAMES = [
  "apply_patch",
  "browser",
  "canvas",
  "code_execution",
  "cron",
  "edit",
  "exec",
  "gateway",
  "memory_get",
  "memory_search",
  "message",
  "nodes",
  "process",
  "sessions_send",
  "sessions_spawn",
  "web_fetch",
  "web_search",
  "write",
  "x_search",
];

function hasWildcardAllow(toolsAllow: string[] | undefined): boolean {
  return toolsAllow?.some((name) => normalizeToolName(name) === "*") === true;
}

function normalizeOptionalToolList(list: Iterable<string> | undefined): string[] | undefined {
  if (!list) {
    return undefined;
  }
  return normalizeToolList(Array.from(list));
}

function explicitAllowSet(toolsAllow: string[] | undefined): Set<string> | undefined {
  if (!toolsAllow || hasWildcardAllow(toolsAllow)) {
    return undefined;
  }
  return new Set(normalizeToolList(toolsAllow));
}

function isSourceSpecificReadonlyTool(normalized: string): boolean {
  return (
    /^jh_[a-z0-9_]*_readonly$/u.test(normalized) ||
    /^openclaw_[a-z0-9_]*_readonly$/u.test(normalized)
  );
}

export function isToolAllowedByTurnSurfacePolicy(
  toolName: string,
  policy: TurnSurfacePolicy,
): boolean {
  if (!policy.enabled) {
    return true;
  }
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return false;
  }
  if (policy.toolsAllow && !hasWildcardAllow(policy.toolsAllow)) {
    return explicitAllowSet(policy.toolsAllow)?.has(normalized) === true;
  }
  return !isToolDeniedByTurnSurfacePolicy(toolName, policy);
}

export function isToolDeniedByTurnSurfacePolicy(
  toolName: string,
  policy: TurnSurfacePolicy,
): boolean {
  if (!policy.enabled) {
    return false;
  }
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return true;
  }
  if (explicitAllowSet(policy.toolsAllow)?.has(normalized)) {
    return false;
  }
  if (policy.excludeToolNames.some((name) => normalizeToolName(name) === normalized)) {
    return true;
  }
  return policy.defaultDenyEnabled && isSourceSpecificReadonlyTool(normalized);
}

export function applyTurnSurfacePolicyToTools<T extends { name: string }>(
  tools: T[],
  policy: TurnSurfacePolicy,
): T[] {
  if (!policy.enabled) {
    return tools;
  }
  return tools.filter((tool) => isToolAllowedByTurnSurfacePolicy(tool.name, policy));
}

export function filterTurnSurfaceRequestedTools(
  requestedTools: string[],
  policy: TurnSurfacePolicy,
): string[] {
  if (!policy.enabled) {
    return requestedTools;
  }
  return requestedTools.filter((toolName) => isToolAllowedByTurnSurfacePolicy(toolName, policy));
}

export function compileTurnSurfacePolicy(params: {
  toolsAllow?: string[];
  excludeToolNames?: Iterable<string>;
  forcedRuntimeToolNames?: string[];
}): TurnSurfacePolicy {
  const normalizedAllow = normalizeOptionalToolList(params.toolsAllow);
  const explicitAllow = explicitAllowSet(normalizedAllow);
  const inheritedDeny = normalizeOptionalToolList(params.excludeToolNames) ?? [];
  const defaultDenyEnabled = params.toolsAllow !== undefined;
  const enabled = defaultDenyEnabled || inheritedDeny.length > 0;
  if (!enabled) {
    return {
      enabled: false,
      toolsAllow: params.toolsAllow,
      excludeToolNames: [],
      defaultDenyEnabled: false,
    };
  }

  const forcedAllowed = filterTurnSurfaceRequestedTools(params.forcedRuntimeToolNames ?? [], {
    enabled: true,
    toolsAllow: normalizedAllow,
    excludeToolNames: inheritedDeny,
    defaultDenyEnabled,
  });
  const toolsAllow =
    normalizedAllow && forcedAllowed.length > 0 && !hasWildcardAllow(normalizedAllow)
      ? Array.from(new Set(normalizeToolList([...normalizedAllow, ...forcedAllowed])))
      : normalizedAllow;
  const allow = explicitAllowSet(toolsAllow) ?? explicitAllow;
  const excludeToolNames = normalizeToolList([
    ...(defaultDenyEnabled
      ? DEFAULT_SCOPE_DENY_TOOL_NAMES.filter((name) => !allow?.has(normalizeToolName(name)))
      : []),
    ...inheritedDeny.filter((name) => !allow?.has(normalizeToolName(name))),
  ]);

  return {
    enabled: true,
    ...(toolsAllow !== undefined ? { toolsAllow } : {}),
    excludeToolNames,
    defaultDenyEnabled,
  };
}
