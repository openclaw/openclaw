import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { Skill } from "../skills/skill-contract.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult, readStringParam } from "./common.js";

const SkillViewToolSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  file: Type.Optional(Type.String({ minLength: 1 })),
});

type SkillMetadata = {
  name: string;
  description: string;
  filePath: string;
  sourceInfo?: Skill["sourceInfo"];
};

type SkillViewOptions = {
  resolvedSkills: readonly Skill[];
  maxBytes?: number;
};

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_CLOSE_MATCHES = 5;

function toMetadata(skill: Skill): SkillMetadata {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    sourceInfo: skill.sourceInfo,
  };
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length] ?? 0;
}

function closeMatches(skills: readonly Skill[], requestedName: string): SkillMetadata[] {
  const query = requestedName.toLowerCase();
  return skills
    .map((skill) => {
      const name = skill.name.toLowerCase();
      const score =
        name.includes(query) || query.includes(name) ? 0 : levenshteinDistance(query, name);
      return { skill, score };
    })
    .toSorted((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, MAX_CLOSE_MATCHES)
    .map((entry) => toMetadata(entry.skill));
}

function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  return (
    skills.find((skill) => skill.name === name) ??
    skills.find((skill) => skill.name.toLowerCase() === name.toLowerCase())
  );
}

function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || /^file:/iu.test(value);
}

function isUnsafeRelativeFile(value: string): boolean {
  if (value.includes("\0") || isUrlLike(value)) {
    return true;
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return true;
  }
  const normalized = value.replace(/\\/gu, "/");
  return normalized
    .split("/")
    .filter(Boolean)
    .some((part) => part === "..");
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveReadableFile(skill: Skill, requestedFile: string | undefined) {
  const skillFileRealPath = await fs.realpath(skill.filePath);
  const skillDirRealPath = await fs.realpath(path.dirname(skillFileRealPath));
  const targetPath = requestedFile
    ? path.resolve(skillDirRealPath, requestedFile)
    : skillFileRealPath;
  const targetRealPath = await fs.realpath(targetPath);

  if (!isWithinDirectory(targetRealPath, skillDirRealPath)) {
    return { ok: false as const, error: "file escapes skill directory" };
  }

  const stat = await fs.stat(targetRealPath);
  if (!stat.isFile()) {
    return { ok: false as const, error: "not a regular file" };
  }

  return { ok: true as const, path: targetRealPath, stat };
}

export function createSkillViewTool(opts: SkillViewOptions): AnyAgentTool {
  const maxBytes = Math.max(1, Math.trunc(opts.maxBytes ?? DEFAULT_MAX_BYTES));
  return {
    label: "Skill View",
    name: "skill_view",
    description:
      "Read a skill file up to 256KB from the skills already resolved for this run. Selects skills by exact name first, then case-insensitive name; optional file must stay within that skill directory.",
    parameters: SkillViewToolSchema,
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const name = readStringParam(params, "name", { required: true });
      const file = readStringParam(params, "file");
      const skill = findSkill(opts.resolvedSkills, name);

      if (!skill) {
        return jsonResult({
          ok: false,
          error: "skill not found",
          requestedName: name,
          closeMatches: closeMatches(opts.resolvedSkills, name),
        });
      }

      if (file && isUnsafeRelativeFile(file)) {
        return jsonResult({
          ok: false,
          error: "invalid relative file path",
          skill: toMetadata(skill),
          requestedFile: file,
        });
      }

      let resolved: Awaited<ReturnType<typeof resolveReadableFile>>;
      try {
        resolved = await resolveReadableFile(skill, file);
      } catch (error) {
        return jsonResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          skill: toMetadata(skill),
          requestedFile: file,
        });
      }

      if (!resolved.ok) {
        return jsonResult({
          ok: false,
          error: resolved.error,
          skill: toMetadata(skill),
          requestedFile: file,
        });
      }

      if (resolved.stat.size > maxBytes) {
        return jsonResult({
          ok: false,
          error: "file too large",
          skill: toMetadata(skill),
          path: resolved.path,
          bytes: resolved.stat.size,
          maxBytes,
        });
      }

      const content = await fs.readFile(resolved.path, "utf8");
      return jsonResult({
        ok: true,
        skill: toMetadata(skill),
        path: resolved.path,
        bytes: Buffer.byteLength(content, "utf8"),
        content,
      });
    },
  };
}
