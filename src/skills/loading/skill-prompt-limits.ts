import { largestFittingValue } from "../../shared/largest-fitting-value.js";
import {
  COMPACT_DESCRIPTION_MAX_CHARS,
  formatSkillsCompactForPrompt,
  formatSkillsForPromptCore,
  type Skill,
} from "./skill-contract.js";

const COMPACT_DESCRIPTION_MIN_CHARS = 4;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000;

type SkillsPromptFormat = { kind: "full" } | { kind: "compact"; descriptionMaxChars: number };

type SkillsPromptParams = {
  skills: Skill[];
  maxSkillsInPrompt?: number;
  maxSkillsPromptChars?: number;
  remoteNote?: string;
  preserveOrder?: boolean;
  /**
   * Minimum description length each admitted skill keeps in the compact catalog.
   * `0` keeps every admitted name even when no description fits; a positive value
   * trades catalog size for trigger text that stays discoverable without a search.
   */
  minDescriptionChars?: number;
};

/** Outcome of the prompt-budget fit, for operator-facing reporting. */
export type SkillsPromptBudget = {
  /** Skills offered to the prompt budget. */
  total: number;
  /** Skills admitted into the rendered catalog. */
  admitted: number;
  /** Names dropped because they did not fit the prompt budget. */
  omitted: string[];
  /** Effective per-skill description cap; `0` when descriptions are omitted. */
  descriptionMaxChars: number;
  /** Rendered catalog format. */
  format: "full" | "compact";
  /** True when the catalog dropped every description. */
  descriptionsOmitted: boolean;
};

/** Render a deterministic skills catalog within the shared model-context budget. */
export function formatSkillsForPromptBounded(params: SkillsPromptParams): string {
  return prepareSkillsForPrompt(params).prompt;
}

/** Summarize how the prompt budget resolved the catalog, for operator-facing reporting. */
function buildBudget(
  orderedSkills: Skill[],
  admitted: Skill[],
  format: "full" | "compact",
  descriptionMaxChars: number,
): SkillsPromptBudget {
  const admittedNames = new Set(admitted.map((skill) => skill.name));
  return {
    total: orderedSkills.length,
    admitted: admitted.length,
    omitted: orderedSkills
      .filter((skill) => !admittedNames.has(skill.name))
      .map((skill) => skill.name),
    descriptionMaxChars,
    format,
    descriptionsOmitted: format === "compact" && descriptionMaxChars <= 0,
  };
}

/** Keep resource selection tied to the exact catalog admitted by the prompt budget. */
export function prepareSkillsForPrompt(params: SkillsPromptParams): {
  prompt: string;
  skills: Skill[];
  budget: SkillsPromptBudget;
} {
  const maxSkillsInPrompt = params.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT;
  const maxSkillsPromptChars = params.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS;
  const orderedSkills = params.preserveOrder
    ? params.skills
    : params.skills.toSorted((a, b) => a.name.localeCompare(b.name, "en"));
  const total = orderedSkills.length;
  const byCount = orderedSkills.slice(0, Math.max(0, maxSkillsInPrompt));
  let skillsForPrompt = byCount;

  const renderWithinLimit = (
    skills: Skill[],
    format: SkillsPromptFormat,
    includeLimitNote = true,
  ): string | undefined => {
    // resolveCodeModeSkills in src/agents/code-mode-skills.ts parses this exact format; update both together.
    // The production-renderer parity test in src/agents/code-mode.skills.test.ts enforces this coupling.
    const truncated = skills.length < total;
    let limitNote = "";
    if (includeLimitNote) {
      if (truncated) {
        const compactDetails =
          format.kind === "compact"
            ? ` (compact format, ${format.descriptionMaxChars > 0 ? "descriptions shortened" : "descriptions omitted"})`
            : "";
        limitNote = `⚠️ Skills truncated: included ${skills.length} of ${total}${compactDetails}. Run \`openclaw skills check\` to audit.`;
      } else if (format.kind === "compact") {
        const compactDetails =
          format.descriptionMaxChars > 0 ? "descriptions shortened" : "descriptions omitted";
        limitNote = `⚠️ Skills catalog using compact format (${compactDetails}). Run \`openclaw skills check\` to audit.`;
      }
    }
    const catalog =
      format.kind === "compact"
        ? formatSkillsCompactForPrompt(skills, {
            descriptionMaxChars: format.descriptionMaxChars,
          })
        : formatSkillsForPromptCore(skills);
    // Reuse the catalog and limit notice when the optional remote note does not fit.
    const prompt = [limitNote, catalog].filter(Boolean).join("\n");
    if (
      params.remoteNote &&
      params.remoteNote.length + prompt.length + (prompt ? 1 : 0) <= maxSkillsPromptChars
    ) {
      return prompt ? `${params.remoteNote}\n${prompt}` : params.remoteNote;
    }
    return prompt.length <= maxSkillsPromptChars ? prompt : undefined;
  };

  const fitsCompact = (
    skills: Skill[],
    descriptionMaxChars: number,
    includeLimitNote = true,
  ): boolean =>
    renderWithinLimit(skills, { kind: "compact", descriptionMaxChars }, includeLimitNote) !==
    undefined;

  const fullPrompt = renderWithinLimit(skillsForPrompt, { kind: "full" });
  if (fullPrompt !== undefined) {
    return {
      prompt: fullPrompt,
      skills: skillsForPrompt,
      budget: buildBudget(orderedSkills, skillsForPrompt, "full", 0),
    };
  }

  // A name-only catalog is not discoverable without a search tool, so a configured
  // description floor is spent on trigger text before extra names are admitted.
  const descriptionFloorChars = Math.max(
    0,
    Math.min(params.minDescriptionChars ?? 0, COMPACT_DESCRIPTION_MAX_CHARS),
  );
  if (!fitsCompact(skillsForPrompt, descriptionFloorChars)) {
    const countWithFloor = largestFittingValue(0, skillsForPrompt.length, (candidateCount) =>
      fitsCompact(skillsForPrompt.slice(0, candidateCount), descriptionFloorChars),
    );
    const countWithoutFloor = largestFittingValue(0, skillsForPrompt.length, (candidateCount) =>
      fitsCompact(skillsForPrompt.slice(0, candidateCount), 0),
    );
    skillsForPrompt = skillsForPrompt.slice(
      0,
      countWithFloor > 0 ? countWithFloor : countWithoutFloor,
    );
  }

  if (skillsForPrompt.length === 0 && byCount.length > 0) {
    const fullWithoutNotice = renderWithinLimit(byCount, { kind: "full" }, false);
    if (fullWithoutNotice !== undefined) {
      return {
        prompt: fullWithoutNotice,
        skills: byCount,
        budget: buildBudget(orderedSkills, byCount, "full", 0),
      };
    }
    const count = largestFittingValue(0, byCount.length, (candidateCount) =>
      fitsCompact(byCount.slice(0, candidateCount), 0, false),
    );
    if (count > 0) {
      skillsForPrompt = byCount.slice(0, count);
    }
  }

  const includeLimitNote = fitsCompact(skillsForPrompt, 0);
  let descriptionMaxChars = 0;
  if (
    skillsForPrompt.length > 0 &&
    fitsCompact(skillsForPrompt, COMPACT_DESCRIPTION_MIN_CHARS, includeLimitNote)
  ) {
    descriptionMaxChars = largestFittingValue(
      COMPACT_DESCRIPTION_MIN_CHARS,
      COMPACT_DESCRIPTION_MAX_CHARS,
      (chars) => fitsCompact(skillsForPrompt, chars, includeLimitNote),
    );
  }
  const prompt =
    renderWithinLimit(
      skillsForPrompt,
      { kind: "compact", descriptionMaxChars },
      includeLimitNote,
    ) ?? "";
  const admitted = prompt ? skillsForPrompt : [];
  return {
    prompt,
    skills: admitted,
    budget: buildBudget(orderedSkills, admitted, "compact", descriptionMaxChars),
  };
}
