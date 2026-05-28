import { resolveSkillRouter } from "./router-registry.js";
import type { SkillRouteResult } from "./router-types.js";
import type { SkillForPrompt } from "./skill-contract.js";
import { formatSkillsForPrompt } from "./skill-contract.js";
import type { SkillEntry } from "./types.js";
import { isSkillVisibleInAvailableSkillsPrompt } from "./workspace.js";

/**
 * Build the candidate list for router matching.
 * Prefers resolvedSkills from snapshot (already filtered); falls back to raw entries.
 */
function buildSkillRouteCandidates(
  resolvedSkills?: Array<{ name: string; description: string; filePath: string }>,
  entries?: SkillEntry[],
): SkillForPrompt[] {
  if (resolvedSkills) {
    return resolvedSkills.map((s) => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
    }));
  }
  return (entries ?? [])
    .filter(isSkillVisibleInAvailableSkillsPrompt)
    .map((e) => ({
      name: e.skill.name,
      description: e.skill.description,
      filePath: e.skill.filePath,
    }));
}

/**
 * Resolve skill routing: call the configured router, then resolve the result
 * to an <available_skills> XML string.
 *
 * Returns:
 * - `{ xml, mode }` — valid match found, inject into user prompt
 * - `{ mode: "nomatch" }` — router explicitly said no skill matches, suppress full catalog
 * - `{ error, reason }` — router was configured but failed; caller should log and fall back
 * - `undefined` — no router configured, no candidates; caller uses full catalog as-is
 */
export async function resolveSkillRoute(ctx: {
  routerName?: string;
  routerConfig?: Record<string, unknown>;
  resolvedSkills?: Array<{ name: string; description: string; filePath: string }>;
  entries?: SkillEntry[];
  query?: string;
}): Promise<
  | { xml: string; mode: "direct" | "ambiguous" }
  | { mode: "nomatch" }
  | { error: true; reason: "registry_miss" | "route_failed" | "lookup_failed" }
  | undefined
> {
  // 1. Guard: no router configured
  if (!ctx.routerName) return undefined;

  // 2. Resolve router from registry
  const router = resolveSkillRouter(ctx.routerName, ctx.routerConfig);
  if (!router) return { error: true, reason: "registry_miss" };

  // 3. Build candidates from resolved skills or raw entries
  const candidates = buildSkillRouteCandidates(ctx.resolvedSkills, ctx.entries);
  if (candidates.length === 0 || !ctx.query) return undefined;

  // 4. Call the router
  let result: SkillRouteResult;
  try {
    result = await router.route(ctx.query, candidates);
  } catch {
    return { error: true, reason: "route_failed" };
  }

  // 5. Resolve result to XML
  if (result.mode === "direct") {
    const matched = candidates.find((c) => c.name === result.name);
    if (matched) {
      const xml = formatSkillsForPrompt([matched]);
      if (xml) return { xml, mode: "direct" };
    }
  } else if (result.mode === "ambiguous" && result.candidates.length > 0) {
    const matched = result.candidates
      .map((c) => candidates.find((m) => m.name === c.name))
      .filter((c): c is NonNullable<typeof c> => c != null);
    if (matched.length > 0) {
      const xml = formatSkillsForPrompt(matched);
      if (xml) return { xml, mode: "ambiguous" };
    }
  } else if (result.mode === "nomatch") {
    return { mode: "nomatch" };
  }

  // 6. Lookup failed — router returned direct/ambiguous but name not in candidates
  return { error: true, reason: "lookup_failed" };
}
