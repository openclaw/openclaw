/**
 * Tool-name matcher support for tool-scoped plugin registrations:
 * before_tool_call / after_tool_call hooks, trusted tool policies, and agent
 * tool result middleware. An omitted matcher always means match-all so
 * existing registrations keep today's behavior.
 */
import { normalizeToolName } from "../agents/tool-policy-shared.js";

/** Tool coverage advertised by tool-scoped plugin registrations. */
export type PluginToolMatcherScope =
  | { matchAll: true }
  | { matchAll: false; toolNames: readonly string[] };

/** Normalizes a registration matcher; omitted, empty, or blank means match-all. */
export function normalizePluginToolMatcher(
  matcher: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!Array.isArray(matcher)) {
    return undefined;
  }
  const names = new Set<string>();
  for (const entry of matcher) {
    const trimmed = typeof entry === "string" ? entry.trim() : "";
    if (trimmed) {
      names.add(trimmed);
    }
  }
  return names.size > 0 ? [...names].toSorted() : undefined;
}

/** True when a registration matcher covers the tool; both sides are policy-normalized. */
export function pluginToolMatcherCoversTool(
  matcher: readonly string[] | undefined,
  toolName: string,
): boolean {
  if (!matcher) {
    return true;
  }
  const normalized = normalizeToolName(toolName);
  return matcher.some((entry) => normalizeToolName(entry) === normalized);
}

/**
 * Unions registration matchers into one scope; any match-all registration
 * forces match-all. Scoped names keep both the registered spelling and the
 * policy-normalized form so adapters can map either onto native tool names.
 */
export function pluginToolScopeFromMatchers(
  matchers: ReadonlyArray<readonly string[] | undefined>,
): PluginToolMatcherScope {
  const toolNames = new Set<string>();
  for (const matcher of matchers) {
    if (!matcher) {
      return { matchAll: true };
    }
    for (const entry of matcher) {
      toolNames.add(entry);
      toolNames.add(normalizeToolName(entry));
    }
  }
  return { matchAll: false, toolNames: [...toolNames].toSorted() };
}

/** Merges already-computed scopes; any match-all input forces match-all. */
export function mergePluginToolScopes(
  scopes: readonly PluginToolMatcherScope[],
): PluginToolMatcherScope {
  const toolNames = new Set<string>();
  for (const scope of scopes) {
    if (scope.matchAll) {
      return { matchAll: true };
    }
    for (const name of scope.toolNames) {
      toolNames.add(name);
    }
  }
  return { matchAll: false, toolNames: [...toolNames].toSorted() };
}
