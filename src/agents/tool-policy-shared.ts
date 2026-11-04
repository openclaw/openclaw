/**
 *
 * Keeps aliases, groups, profile expansion, and prefix matching consistent across allow/deny paths.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { CORE_TOOL_GROUPS } from "./tool-catalog.js";

export { resolveCoreToolProfilePolicy as resolveToolProfilePolicy } from "./tool-catalog.js";
export type { ToolProfileId } from "./tool-catalog.js";

const TOOL_NAME_ALIASES = new Map<string, string>([
  ["bash", "exec"],
  ["apply-patch", "apply_patch"],
  // v2026.10.1 policies must still govern the renamed Tool Search dispatcher.
  ["tool_call", "dispatch_action"],
  // Permanent scheduler-tool alias (owner decision, RFC 0026), like bash -> exec.
  ["cron", "automations"],
]);

const TOOL_ALLOWLIST_INTERSECTION = Symbol.for("openclaw.toolAllowlistIntersection");
type ToolAllowlistWithIntersection = readonly string[] & {
  [TOOL_ALLOWLIST_INTERSECTION]?: readonly string[][];
};

const TOOL_GROUPS: Record<string, string[]> = { ...CORE_TOOL_GROUPS };

/**
 * Preserves independent allowlists until a concrete tool surface can evaluate
 * them. Intersections of overlapping globs cannot be represented by one glob list.
 */
export function attachToolAllowlistIntersection(
  toolsAllow: string[],
  restrictions: readonly string[][],
): string[] {
  Object.defineProperty(toolsAllow, TOOL_ALLOWLIST_INTERSECTION, {
    configurable: true,
    enumerable: false,
    value: restrictions,
  });
  return toolsAllow;
}

/** Reads independent restrictions attached by a modifying-hook merger. */
export function readToolAllowlistIntersection(
  toolsAllow: readonly string[],
): readonly string[][] | undefined {
  return (toolsAllow as ToolAllowlistWithIntersection)[TOOL_ALLOWLIST_INTERSECTION];
}

const TOOL_ALLOWLIST_PRODUCER_SURFACE = Symbol.for("openclaw.toolAllowlistProducerSurface");
/** An allowlist that may carry the producer-surface fact; a plain list satisfies it. */
export type ToolAllowlistWithProducerSurface = readonly string[] & {
  [TOOL_ALLOWLIST_PRODUCER_SURFACE]?: true;
};

/**
 * Records that an allowlist is the producing run's own authorized surface rather than a
 * policy narrowing. It still bounds the tools a woken or inherited turn may reach, but
 * consumers that shrink prompts for restricted runs must not read it as a restriction:
 * the capped turn builds exactly the surface the producer already advertised.
 */
export function markToolAllowlistAsProducerSurface<T extends string[]>(toolsAllow: T): T {
  Object.defineProperty(toolsAllow, TOOL_ALLOWLIST_PRODUCER_SURFACE, {
    configurable: true,
    enumerable: false,
    value: true,
  });
  return toolsAllow;
}

/** Reads the producer-surface fact; absent on plain copies and on explicit caps. */
export function isProducerSurfaceToolAllowlist(
  toolsAllow: ToolAllowlistWithProducerSurface | undefined,
): boolean {
  return toolsAllow?.[TOOL_ALLOWLIST_PRODUCER_SURFACE] === true;
}

/** Carries the producer-surface fact onto a list derived from a single marked source. */
export function retainProducerSurfaceToolAllowlist<T extends string[]>(
  toolsAllow: T,
  source: ToolAllowlistWithProducerSurface | undefined,
): T {
  return isProducerSurfaceToolAllowlist(source)
    ? markToolAllowlistAsProducerSurface(toolsAllow)
    : toolsAllow;
}

/** Narrows a caller's event cap to its inherited owner's, keeping shared provenance. */
export function intersectProducerSurfaceToolAllowlists(
  identityAllow: ToolAllowlistWithProducerSurface | undefined,
  inheritedAllow: ToolAllowlistWithProducerSurface | undefined,
): readonly string[] | undefined {
  if (!identityAllow || !inheritedAllow) {
    return identityAllow ?? inheritedAllow;
  }
  const shared = identityAllow.filter((name) => inheritedAllow.includes(name));
  return isProducerSurfaceToolAllowlist(identityAllow) &&
    isProducerSurfaceToolAllowlist(inheritedAllow)
    ? markToolAllowlistAsProducerSurface(shared)
    : shared;
}

/**
 * Normal (non-error) result for a tool that keeps its schema but sits outside the run's
 * execution allowlist. Background runs treat it as guidance, never as a run failure.
 */
export function formatToolExecutionGatedMessage(
  toolName: string,
  allowNames: readonly string[],
): string {
  const allowed = allowNames.length > 0 ? allowNames.join(", ") : "the tools named in your task";
  return `${toolName} is not available in this background run. Use ${allowed} instead; do not retry ${toolName}.`;
}

export function isToolExecutionAllowed(allowNames: readonly string[], toolName: string): boolean {
  const target = normalizeToolPolicyName(toolName);
  return allowNames.some((name) => normalizeToolPolicyName(name) === target);
}

/** Snapshot exact names for one synchronous batch; never retain this matcher across awaits. */
export function createToolExecutionMatcher(allowNames: readonly string[]) {
  const allowed = new Set(allowNames.map(normalizeToolPolicyName));
  return (toolName: string) => allowed.has(normalizeToolPolicyName(toolName));
}

export function normalizeToolPolicyName(name: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return TOOL_NAME_ALIASES.get(normalized) ?? normalized;
}

export function couldNormalizeToolNamePrefixToAllowedTool(
  prefix: string,
  allowedToolNames: Set<string>,
): boolean {
  const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
  if (!normalizedPrefix) {
    return false;
  }

  const allowed = new Set<string>();
  for (const toolName of allowedToolNames) {
    const foldedToolName = normalizeLowercaseStringOrEmpty(toolName);
    const normalizedToolName = TOOL_NAME_ALIASES.get(foldedToolName) ?? foldedToolName;
    if (normalizedToolName) {
      allowed.add(normalizedToolName);
    }
    if (foldedToolName) {
      allowed.add(foldedToolName);
    }
    if (
      normalizedToolName.startsWith(normalizedPrefix) ||
      foldedToolName.startsWith(normalizedPrefix)
    ) {
      return true;
    }
  }

  const resolvedPrefix = TOOL_NAME_ALIASES.get(normalizedPrefix) ?? normalizedPrefix;
  if (resolvedPrefix !== normalizedPrefix) {
    for (const toolName of allowed) {
      if (toolName.startsWith(resolvedPrefix)) {
        return true;
      }
    }
  }

  for (const [alias, toolName] of TOOL_NAME_ALIASES) {
    if (alias.startsWith(normalizedPrefix) && allowed.has(toolName)) {
      return true;
    }
  }
  return false;
}

/** Normalizes a configured allow/deny list while dropping blank entries. */
export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolPolicyName).filter(Boolean);
}

export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = Object.hasOwn(TOOL_GROUPS, value) ? TOOL_GROUPS[value] : undefined;
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return uniqueStrings(expanded);
}
