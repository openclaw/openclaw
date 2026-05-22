import { Type } from "typebox";
import type { Skill } from "../skills/skill-contract.js";
import type { SkillSnapshot } from "../skills/types.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult, readNumberParam, readStringParam } from "./common.js";

const SkillRouteToolSchema = Type.Object({
  query: Type.String({
    description: "User request or task to match against available skills.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum matches to return. Defaults to 5.",
    }),
  ),
});

type RouteSkillCandidate = {
  name: string;
  description?: string;
  location?: string;
};

type SkillRouteMatch = {
  name: string;
  score: number;
  description?: string;
  location?: string;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MATCH_THRESHOLD = 0.25;
const AMBIGUOUS_SCORE_DELTA = 0.08;
const WORD_RE = /[\p{L}\p{N}]+/gu;

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKC");
}

function tokenize(value: string): string[] {
  return [...normalizeText(value).matchAll(WORD_RE)]
    .map((match) => match[0])
    .filter((token) => token.length >= 2);
}

function uniqueTokens(value: string): Set<string> {
  return new Set(tokenize(value));
}

function resolveSkillCandidates(snapshot?: SkillSnapshot): RouteSkillCandidate[] {
  const resolved = snapshot?.resolvedSkills ?? [];
  if (resolved.length > 0) {
    return resolved.map((skill) => ({
      name: skill.name,
      description: skill.description,
      location: skill.filePath,
    }));
  }

  return (snapshot?.skills ?? []).map((skill) => ({ name: skill.name }));
}

function scoreSkill(query: string, skill: RouteSkillCandidate): number {
  const queryTokens = uniqueTokens(query);
  if (queryTokens.size === 0) {
    return 0;
  }

  const name = normalizeText(skill.name);
  const description = normalizeText(skill.description ?? "");
  const haystack = `${name} ${description}`;
  const skillTokens = uniqueTokens(haystack);
  let score = 0;
  for (const token of queryTokens) {
    if (name.includes(token)) {
      score += 0.34;
      continue;
    }
    if (skillTokens.has(token)) {
      score += 0.2;
      continue;
    }
    if (
      [...skillTokens].some(
        (skillToken) => skillToken.includes(token) || token.includes(skillToken),
      )
    ) {
      score += 0.08;
    }
  }

  const queryNormalized = normalizeText(query);
  if (queryNormalized.includes(name) || name.includes(queryNormalized)) {
    score += 0.55;
  }

  return Number(Math.min(score / Math.max(queryTokens.size, 1), 1).toFixed(3));
}

export function rankSkillRoutes(params: {
  query: string;
  skills: Skill[];
  limit?: number;
}): SkillRouteMatch[] {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  return params.skills
    .map((skill) => ({
      name: skill.name,
      score: scoreSkill(params.query, {
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
      }),
      description: skill.description,
      location: skill.filePath,
    }))
    .filter((match) => match.score > 0)
    .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function createSkillRouteTool(opts?: {
  skillsSnapshot?: SkillSnapshot;
}): AnyAgentTool | null {
  const candidates = resolveSkillCandidates(opts?.skillsSnapshot);
  if (candidates.length === 0) {
    return null;
  }

  return {
    label: "Skill Route",
    name: "local_skill_route",
    description:
      "Find likely local skills for the current task. Use before reading SKILL.md when skill choice is unclear or the skills list is large.",
    parameters: SkillRouteToolSchema,
    execute: async (_toolCallId, params) => {
      const record = asToolParamsRecord(params);
      const query = readStringParam(record, "query", { required: true });
      const limit = Math.min(
        Math.max(readNumberParam(record, "limit", { integer: true }) ?? DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );
      const matches = candidates
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          location: skill.location,
          score: scoreSkill(query, skill),
        }))
        .filter((match) => match.score > 0)
        .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, limit);
      const strongMatches = matches.filter((match) => match.score >= MATCH_THRESHOLD);
      const top = strongMatches[0];
      const runnerUp = strongMatches[1];
      const status = !top
        ? "nomatch"
        : runnerUp && top.score - runnerUp.score <= AMBIGUOUS_SCORE_DELTA
          ? "ambiguous"
          : "matched";
      const instruction =
        status === "matched" && top?.location
          ? `Read ${top.location} before using the skill.`
          : status === "ambiguous"
            ? "Ask the user to choose, or read the most specific matching SKILL.md if the task context disambiguates it."
            : "Do not read a skill unless the task gives a clearer match.";

      return jsonResult({
        status,
        query,
        instruction,
        matches: status === "nomatch" ? matches.slice(0, limit) : strongMatches.slice(0, limit),
      });
    },
  };
}
