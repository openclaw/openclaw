import { Type } from "typebox";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { Skill } from "../skills/skill-contract.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult, readNumberParam, readStringParam } from "./common.js";

const log = createSubsystemLogger("agents/tools/skill-search");

const SkillSearchToolSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
});

type SkillSearchResult = {
  name: string;
  description: string;
  filePath: string;
  sourceInfo?: Skill["sourceInfo"];
};

type ScoredSkill = {
  skill: Skill;
  score: number;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

function clampLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_-]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreSkill(skill: Skill, query: string, queryTerms: readonly string[]): number {
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const haystack = `${name}\n${description}`;
  let score = 0;

  if (name === query) {
    score += 100;
  } else if (name.includes(query)) {
    score += 50;
  }
  if (description.includes(query)) {
    score += 20;
  }

  for (const term of queryTerms) {
    if (name === term) {
      score += 30;
    } else if (name.includes(term)) {
      score += 12;
    }
    if (description.includes(term)) {
      score += 6;
    }
    if (haystack.includes(term)) {
      score += 1;
    }
  }

  return score;
}

function toSearchResult(skill: Skill): SkillSearchResult {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    sourceInfo: skill.sourceInfo,
  };
}

export function createSkillSearchTool(opts: { resolvedSkills: readonly Skill[] }): AnyAgentTool {
  return {
    label: "Skill Search",
    name: "skill_search",
    description:
      "Search the skills already resolved for this run by name and description. Returns metadata only; use skill_view to read a selected skill file.",
    parameters: SkillSearchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const query = readStringParam(params, "query", { required: true }).toLowerCase();
      const limit = clampLimit(readNumberParam(params, "limit", { integer: true }));
      const terms = tokenize(query);

      const results = opts.resolvedSkills
        .map((skill): ScoredSkill => ({ skill, score: scoreSkill(skill, query, terms) }))
        .filter((entry) => entry.score > 0)
        .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
        .slice(0, limit)
        .map((entry) => toSearchResult(entry.skill));

      log.info("skill_search", {
        queryLength: query.length,
        termCount: terms.length,
        limit,
        resultCount: results.length,
        resolvedSkillCount: opts.resolvedSkills.length,
      });

      return jsonResult({
        ok: true,
        query,
        count: results.length,
        results,
      });
    },
  };
}
