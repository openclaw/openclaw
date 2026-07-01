// Local skill loader reads skill definitions from local filesystem roots.
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync } from "../../infra/boundary-file-read.js";
import type { ParsedSkillFrontmatter } from "../types.js";
import {
  frontmatterYamlSyntaxError,
  parseFrontmatter,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";
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
  // Strict callers (skills lint) report malformed YAML the permissive runtime parser hides.
  strictYaml?: boolean;
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

  if (params.strictYaml) {
    const yamlError = frontmatterYamlSyntaxError(raw);
    if (yamlError) {
      return {
        ok: false,
        failure: { dir, filePath, reason: "parse-error", message: yamlError },
      };
    }
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

// Bounds so `skills lint` on a broad root cannot become an unbounded filesystem walk;
// mirrors the spirit of runtime's budgeted nested skill-group discovery.
const MAX_LINT_SCAN_DEPTH = 4;
const MAX_LINT_CANDIDATE_DIRS = 2000;

// Like listCandidateSkillDirs but also follows directory symlinks, matching runtime's
// nested discovery so `skills lint` inspects the same candidate set. Cycle safety comes
// from the caller's real-path dedupe; reads stay bounded by the skill-root boundary helper.
function listLintCandidateChildDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.push(fullPath);
    } else if (entry.isSymbolicLink()) {
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          dirs.push(fullPath);
        }
      } catch {
        // Broken or unreadable symlink: skip it like runtime discovery does.
      }
    }
  }
  return dirs.toSorted((left, right) => left.localeCompare(right));
}

/**
 * Recursively collects SKILL.md load failures under a root for `skills lint`, descending
 * into nested skill groups the same way runtime discovery does (a directory that is itself
 * a skill is a leaf). `strictYaml` additionally reports malformed YAML. Bounded by depth and
 * a candidate cap. Symlinks are not followed, matching the safe single-dir loader.
 */
export function collectSkillLoadFailures(params: {
  dir: string;
  source: string;
  strictYaml?: boolean;
  maxBytes?: number;
}): SkillLoadFailure[] {
  const rootDir = path.resolve(params.dir);
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(rootDir);
  } catch {
    return [];
  }

  const failures: SkillLoadFailure[] = [];
  // Dedupe by real path, not the symlinked path, so a directory symlink that loops back
  // (or two links to the same target) cannot revisit a directory or spin forever.
  const seenReal = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_LINT_CANDIDATE_DIRS) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let realDir: string;
    try {
      realDir = fs.realpathSync(current.dir);
    } catch {
      continue;
    }
    if (seenReal.has(realDir)) {
      continue;
    }
    seenReal.add(realDir);
    scanned += 1;

    if (fs.existsSync(path.join(current.dir, "SKILL.md"))) {
      const result = loadSingleSkillDirectory({
        skillDir: current.dir,
        source: params.source,
        rootRealPath,
        maxBytes: params.maxBytes,
        strictYaml: params.strictYaml,
      });
      if (!result.ok && result.failure) {
        failures.push(result.failure);
      }
      // A directory that is itself a skill is a leaf; its subdirs are assets, not skills.
      continue;
    }
    if (current.depth >= MAX_LINT_SCAN_DEPTH) {
      continue;
    }
    for (const childDir of listLintCandidateChildDirs(current.dir)) {
      queue.push({ dir: childDir, depth: current.depth + 1 });
    }
  }
  return failures;
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
