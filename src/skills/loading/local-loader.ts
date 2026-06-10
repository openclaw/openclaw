// Local skill loader reads skill definitions from local filesystem roots.
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync } from "../../infra/boundary-file-read.js";
import type { ParsedSkillFrontmatter } from "../types.js";
import { parseFrontmatter, resolveSkillInvocationPolicy } from "./frontmatter.js";
import { createSyntheticSourceInfo, type Skill } from "./skill-contract.js";
import { computeSkillPromptVersion } from "./skill-version.js";

type LoadedLocalSkill = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
};

/** Why a SKILL.md directory was skipped during a safe load, for author-facing diagnostics. */
export type SkillLoadFailure =
  | { dir: string; filePath: string; reason: "parse-error"; message: string }
  | {
      dir: string;
      filePath: string;
      reason: "missing-required-field";
      field: "name" | "description";
    };

type LoadSingleSkillResult =
  | { ok: true; loaded: LoadedLocalSkill }
  | { ok: false; failure: SkillLoadFailure }
  // The directory has no SKILL.md at all; not a malformed skill, just not a skill dir.
  | { ok: false; failure: null };

// Read SKILL.md through the root boundary helper so symlinks cannot escape the skill root.
function readSkillFileSync(params: {
  rootRealPath: string;
  filePath: string;
  maxBytes?: number;
}): string | null {
  const opened = openRootFileSync({
    absolutePath: params.filePath,
    rootPath: params.rootRealPath,
    rootRealPath: params.rootRealPath,
    boundaryLabel: "skill root",
    maxBytes: params.maxBytes,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    return fs.readFileSync(opened.fd, "utf8");
  } finally {
    fs.closeSync(opened.fd);
  }
}

function loadSingleSkillDirectory(params: {
  skillDir: string;
  source: string;
  rootRealPath: string;
  maxBytes?: number;
}): LoadSingleSkillResult {
  const skillFilePath = path.join(params.skillDir, "SKILL.md");
  const filePath = path.resolve(skillFilePath);
  const dir = path.resolve(params.skillDir);
  const raw = readSkillFileSync({
    rootRealPath: params.rootRealPath,
    filePath: skillFilePath,
    maxBytes: params.maxBytes,
  });
  if (!raw) {
    return { ok: false, failure: null };
  }

  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseFrontmatter(raw);
  } catch (err) {
    return {
      ok: false,
      failure: { dir, filePath, reason: "parse-error", message: String(err) },
    };
  }

  const fallbackName = path.basename(params.skillDir).trim();
  const name = frontmatter.name?.trim() || fallbackName;
  const description = frontmatter.description?.trim();
  if (!name) {
    return {
      ok: false,
      failure: { dir, filePath, reason: "missing-required-field", field: "name" },
    };
  }
  if (!description) {
    return {
      ok: false,
      failure: { dir, filePath, reason: "missing-required-field", field: "description" },
    };
  }
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  const baseDir = dir;

  return {
    ok: true,
    loaded: {
      skill: {
        name,
        description,
        filePath,
        baseDir,
        promptVersion: computeSkillPromptVersion(raw),
        source: params.source,
        sourceInfo: createSyntheticSourceInfo(filePath, {
          source: params.source,
          baseDir,
          scope: "project",
          origin: "top-level",
        }),
        disableModelInvocation: invocation.disableModelInvocation,
      },
      frontmatter,
    },
  };
}

function listCandidateSkillDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
      )
      .map((entry) => path.join(dir, entry.name))
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** Result of a safe local skill load: loaded skills plus author-facing skip diagnostics. */
export type LoadSkillsFromDirSafeResult = {
  skills: Skill[];
  frontmatterByFilePath: ReadonlyMap<string, ParsedSkillFrontmatter>;
  // Directories that contained a SKILL.md but failed to load, with a structured reason.
  skipped: SkillLoadFailure[];
};

/** Loads skills from a local directory while turning read/parse failures into diagnostics. */
export function loadSkillsFromDirSafe(params: {
  dir: string;
  source: string;
  maxBytes?: number;
}): LoadSkillsFromDirSafeResult {
  const rootDir = path.resolve(params.dir);
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(rootDir);
  } catch {
    return { skills: [], frontmatterByFilePath: new Map(), skipped: [] };
  }

  const rootResult = loadSingleSkillDirectory({
    skillDir: rootDir,
    source: params.source,
    rootRealPath,
    maxBytes: params.maxBytes,
  });
  if (rootResult.ok) {
    return {
      skills: [rootResult.loaded.skill],
      frontmatterByFilePath: new Map([
        [rootResult.loaded.skill.filePath, rootResult.loaded.frontmatter],
      ]),
      skipped: [],
    };
  }
  // A malformed root SKILL.md is a skipped skill; a missing one means scan child dirs.
  if (rootResult.failure) {
    return { skills: [], frontmatterByFilePath: new Map(), skipped: [rootResult.failure] };
  }

  const loadedSkills: LoadedLocalSkill[] = [];
  const skipped: SkillLoadFailure[] = [];
  for (const skillDir of listCandidateSkillDirs(rootDir)) {
    const result = loadSingleSkillDirectory({
      skillDir,
      source: params.source,
      rootRealPath,
      maxBytes: params.maxBytes,
    });
    if (result.ok) {
      loadedSkills.push(result.loaded);
    } else if (result.failure) {
      skipped.push(result.failure);
    }
  }
  const frontmatterByFilePath = new Map<string, ParsedSkillFrontmatter>();
  for (const loaded of loadedSkills) {
    frontmatterByFilePath.set(loaded.skill.filePath, loaded.frontmatter);
  }

  return {
    skills: loadedSkills.map((loaded) => loaded.skill),
    frontmatterByFilePath,
    skipped,
  };
}

export function readSkillFrontmatterSafe(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
}): Record<string, string> | null {
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(path.resolve(params.rootDir));
  } catch {
    return null;
  }
  const raw = readSkillFileSync({
    rootRealPath,
    filePath: path.resolve(params.filePath),
    maxBytes: params.maxBytes,
  });
  if (!raw) {
    return null;
  }
  try {
    return parseFrontmatter(raw);
  } catch {
    return null;
  }
}
