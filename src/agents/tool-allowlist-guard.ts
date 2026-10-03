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
  /** The runtime supplied this list as a default; no operator authored it. */
  runtimeSupplied?: boolean;
};

/** Normalize explicit allowlist sources, dropping empty source entries. */
export function collectExplicitToolAllowlistSources(
  sources: Array<{
    label: string;
    allow?: string[];
    enforceWhenToolsDisabled?: boolean;
    runtimeSupplied?: boolean;
  }>,
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
        ...(source.runtimeSupplied === true ? { runtimeSupplied: true } : {}),
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
  /** Server-stamped scheduled authority that capped this run, when present. */
  scheduledToolPolicyMode?: "trusted" | "account";
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
  // Every enforced source is a runtime-supplied default (for example a cron job
  // whose `toolsAllowIsDefault` payload copied its creator turn's surface). The
  // operator never wrote this list, so pointing them at "the allowlist" or a
  // missing plugin sends them after a cause that is not theirs.
  if (sources.every((source) => source.runtimeSupplied === true)) {
    const scheduledClause =
      params.scheduledToolPolicyMode === "account"
        ? ' and a scheduled "account" tool policy capped this run to that session\'s authority'
        : "";
    return new Error(
      `No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. This allowlist was captured automatically from the session that created it, not written by an operator${scheduledClause}. Recreate the run from a session that can call the tools it needs, or set an explicit tool allowlist.`,
    );
  }
  return new Error(
    `No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. Fix the allowlist or enable the plugin that registers the requested tool.`,
  );
}
