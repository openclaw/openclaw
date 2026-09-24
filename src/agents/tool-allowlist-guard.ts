/**
 * Explicit tool allowlist guard.
 *
 * Collects operator/user allowlist sources and explains when no callable tools remain.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  resolveSkillWorkshopToolConstructionBlock,
  type SkillWorkshopToolConstructionContext,
} from "../skills/workshop/tool-availability.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

type ExplicitToolAllowlistSource = {
  label: string;
  entries: string[];
  enforceWhenToolsDisabled?: boolean;
};

/** Normalize explicit allowlist sources, dropping empty source entries. */
export function collectExplicitToolAllowlistSources(
  sources: Array<{ label: string; allow?: string[]; enforceWhenToolsDisabled?: boolean }>,
): ExplicitToolAllowlistSource[] {
  return sources.flatMap((source) => {
    const entries = normalizeStringEntries(source.allow);
    if (entries.length === 0) {
      return [];
    }
    return [
      {
        label: source.label,
        entries,
        ...(source.enforceWhenToolsDisabled === true ? { enforceWhenToolsDisabled: true } : {}),
      },
    ];
  });
}

/** Build an actionable error when explicit allowlists remove every callable tool. */
export function buildEmptyExplicitToolAllowlistError(params: {
  sources: ExplicitToolAllowlistSource[];
  hasCallableTools: boolean;
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllowExplicitlyEmpty?: boolean;
  skillWorkshop?: SkillWorkshopToolConstructionContext;
}): Error | null {
  const toolsIntentionallyDisabled =
    params.disableTools === true || params.toolsAllowExplicitlyEmpty === true;
  const sources = toolsIntentionallyDisabled
    ? params.sources.filter((source) => source.enforceWhenToolsDisabled === true)
    : params.sources;
  if (sources.length === 0 || params.hasCallableTools) {
    return null;
  }
  const requested = sources
    .map((source) => `${source.label}: ${source.entries.map(normalizeToolPolicyName).join(", ")}`)
    .join("; ");
  const workshopBlock =
    params.skillWorkshop &&
    sources.every((source) =>
      isToolAllowedByPolicyName("skill_workshop", { allow: source.entries }),
    )
      ? resolveSkillWorkshopToolConstructionBlock(params.skillWorkshop)
      : undefined;
  if (params.toolsEnabled && !toolsIntentionallyDisabled && workshopBlock) {
    return new Error(
      `No callable tools remain after resolving explicit tool allowlist (${requested}); ${workshopBlock.detail} ${workshopBlock.fix}`,
    );
  }
  const reason =
    params.disableTools === true
      ? "tools are disabled for this run"
      : params.toolsEnabled
        ? "no registered tools matched"
        : "the selected model does not support tools";
  return new Error(
    `No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. Fix the allowlist or enable the plugin that registers the requested tool.`,
  );
}
