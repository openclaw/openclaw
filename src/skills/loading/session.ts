import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "../../agents/config.js";
import { CONFIG_DIR_NAME } from "../../agents/package-metadata.js";
import type { ResourceDiagnostic } from "../../agents/sessions/diagnostics.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  addIgnoreRules,
  normalizeNativePathSeparators,
  type IgnoreMatcher,
} from "../../shared/ignore-rules.js";
import { expandTildePath } from "../../shared/tilde-path.js";
import { parseSkillFrontmatter } from "./frontmatter.js";
import type { Skill } from "./skill-contract.js";
import { materializeSkill } from "./skill-materializer.js";
import { formatSkillsForPromptBounded } from "./skill-prompt-limits.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export type { Skill } from "./skill-contract.js";

interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
}

function validateName(name: string): string[] {
  const errors: string[] = [];

  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push(`name must not start or end with a hyphen`);
  }

  if (name.includes("--")) {
    errors.push(`name must not contain consecutive hyphens`);
  }

  return errors;
}

function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];

  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }

  return errors;
}

function resolveSkillSourceOptions(
  source: string,
): Parameters<typeof materializeSkill>[0]["sourceOptions"] {
  if (source === "user" || source === "project") {
    return { source: "local", scope: source };
  }
  return { source: source === "path" ? "local" : source };
}

function loadSkillsFromDirInternal(
  dir: string,
  source: string,
  includeRootFiles: boolean,
  ignoreMatcher?: IgnoreMatcher,
  rootDir?: string,
): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: ResourceDiagnostic[] = [];

  if (!existsSync(dir)) {
    return { skills, diagnostics };
  }

  const root = rootDir ?? dir;
  const ig = addIgnoreRules(dir, root, ignoreMatcher);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name !== "SKILL.md") {
        continue;
      }

      const fullPath = join(dir, entry.name);

      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }

      const relPath = normalizeNativePathSeparators(relative(root, fullPath));
      if (!isFile || ig.ignores(relPath)) {
        continue;
      }

      return loadSkillFromFile(fullPath, source);
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      if (entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(dir, entry.name);

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      const relPath = normalizeNativePathSeparators(relative(root, fullPath));
      const ignorePath = isDirectory ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) {
        continue;
      }

      if (!isDirectory && (!isFile || !includeRootFiles || !entry.name.endsWith(".md"))) {
        continue;
      }
      const result = isDirectory
        ? loadSkillsFromDirInternal(fullPath, source, false, ig, root)
        : loadSkillFromFile(fullPath, source);
      skills.push(...result.skills);
      diagnostics.push(...result.diagnostics);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to scan skill directory";
    diagnostics.push({ type: "warning", message, path: dir });
  }

  return { skills, diagnostics };
}

function loadSkillFromFile(filePath: string, source: string): LoadSkillsResult {
  const diagnostics: ResourceDiagnostic[] = [];

  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const frontmatter = parseSkillFrontmatter(rawContent);
    const skillDir = dirname(filePath);
    const name = frontmatter.name || basename(skillDir);
    for (const error of [...validateDescription(frontmatter.description), ...validateName(name)]) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }

    // Still load the skill even with warnings (unless description is completely missing)
    if (!frontmatter.description || frontmatter.description.trim() === "") {
      return { skills: [], diagnostics };
    }

    return {
      skills: [
        materializeSkill({
          content: rawContent,
          frontmatter,
          name,
          description: frontmatter.description,
          filePath,
          baseDir: skillDir,
          source,
          sourceOptions: resolveSkillSourceOptions(source),
        }),
      ],
      diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to parse skill file";
    diagnostics.push({ type: "warning", message, path: filePath });
    return { skills: [], diagnostics };
  }
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  return formatSkillsForPromptBounded({ skills: visibleSkills });
}

interface LoadSkillsOptions {
  /** Working directory for project-local skills. */
  cwd: string;
  /** Agent config directory for global skills. */
  agentDir: string;
  /** Explicit skill paths (files or directories) */
  skillPaths: string[];
  /** Include default skills directories. */
  includeDefaults: boolean;
}

function resolveSkillPath(p: string, cwd: string): string {
  const normalized = expandTildePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
  const { cwd, agentDir, skillPaths, includeDefaults } = options;

  const resolvedAgentDir = agentDir ?? getAgentDir();

  const skillMap = new Map<string, Skill>();
  const realPathSet = new Set<string>();
  const allDiagnostics: ResourceDiagnostic[] = [];
  const collisionDiagnostics: ResourceDiagnostic[] = [];

  function addSkills(result: LoadSkillsResult) {
    allDiagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      const realPath = canonicalizePath(skill.filePath);

      if (realPathSet.has(realPath)) {
        continue;
      }

      const existing = skillMap.get(skill.name);
      if (existing) {
        collisionDiagnostics.push({
          type: "collision",
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
          collision: {
            resourceType: "skill",
            name: skill.name,
            winnerPath: existing.filePath,
            loserPath: skill.filePath,
          },
        });
      } else {
        skillMap.set(skill.name, skill);
        realPathSet.add(realPath);
      }
    }
  }

  if (includeDefaults) {
    addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
    addSkills(loadSkillsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, "skills"), "project", true));
  }

  const userSkillsDir = join(resolvedAgentDir, "skills");
  const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");

  const getSource = (resolvedPath: string): "user" | "project" | "path" => {
    if (!includeDefaults) {
      if (isPathInside(userSkillsDir, resolvedPath)) {
        return "user";
      }
      if (isPathInside(projectSkillsDir, resolvedPath)) {
        return "project";
      }
    }
    return "path";
  };

  for (const rawPath of skillPaths) {
    const resolvedPath = resolveSkillPath(rawPath, cwd);
    if (!existsSync(resolvedPath)) {
      allDiagnostics.push({
        type: "warning",
        message: "skill path does not exist",
        path: resolvedPath,
      });
      continue;
    }

    try {
      const stats = statSync(resolvedPath);
      const source = getSource(resolvedPath);
      if (stats.isDirectory()) {
        addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
      } else if (stats.isFile() && resolvedPath.endsWith(".md")) {
        addSkills(loadSkillFromFile(resolvedPath, source));
      } else {
        allDiagnostics.push({
          type: "warning",
          message: "skill path is not a markdown file",
          path: resolvedPath,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to read skill path";
      allDiagnostics.push({ type: "warning", message, path: resolvedPath });
    }
  }

  return {
    skills: Array.from(skillMap.values()),
    diagnostics: [...allDiagnostics, ...collisionDiagnostics],
  };
}
