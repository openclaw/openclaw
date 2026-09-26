import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isSessionSkillEnabled,
  resolveEffectiveAgentSkillFilter,
} from "../discovery/agent-filter.js";
import { normalizeSkillFilter } from "../discovery/filter.js";
import { assertUnambiguousManagedSkillNames } from "../library/command-name.js";
import type { SkillEligibilityContext, SkillEntry } from "../types.js";
import { resolveBundledAllowlist, shouldIncludeSkill } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";

const skillsLogger = createSubsystemLogger("skills");

export function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  skillOverrides?: Readonly<Record<string, boolean>>,
  eligibility?: SkillEligibilityContext,
  hasBin?: (bin: string) => boolean,
  platform?: string,
): SkillEntry[] {
  const bundledAllowlist = resolveBundledAllowlist(config);
  assertUnambiguousManagedSkillNames(entries);
  const normalized = normalizeSkillFilter(skillFilter);
  const filtered = entries.filter(
    (entry) =>
      isSessionSkillEnabled(
        entry.skill.name,
        normalized,
        skillOverrides,
        resolveSkillKey(entry.skill, entry),
      ) && shouldIncludeSkill({ entry, config, bundledAllowlist, eligibility, hasBin, platform }),
  );
  if (skillFilter !== undefined || skillOverrides !== undefined) {
    const label = normalized?.length ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

export function resolveEffectiveWorkspaceSkillFilter(opts?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentSkillFilter?: "apply" | "ignore";
  skillFilter?: string[];
}): string[] | undefined {
  if (opts?.skillFilter !== undefined) {
    return normalizeSkillFilter(opts.skillFilter);
  }
  if (opts?.agentSkillFilter === "ignore" || !opts?.config || !opts.agentId) {
    return undefined;
  }
  return resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
}
