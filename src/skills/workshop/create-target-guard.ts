import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOsHomeDir } from "../../infra/home-dir.js";
import { loadWorkspaceSkillEntries } from "../loading/workspace.js";

// Create proposals are for new skills; existing workspace skill paths must be
// updated through action=update so the live target hash/rollback guard applies.
const PATH_REFERENCE_BOUNDARY_CHARS = new Set([
  " ",
  "\n",
  "\r",
  "\t",
  '"',
  "'",
  "`",
  "(",
  "[",
  "{",
  "|",
  "<",
  ">",
]);

export function assertCreateProposalDoesNotPatchExistingSkills(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  content: string;
}): void {
  const existingSkillRefs = collectExistingWorkspaceSkillRefs(params);
  if (existingSkillRefs.length === 0) {
    return;
  }
  const refs = existingSkillRefs.join(", ");
  throw new Error(
    `action=create cannot propose changes to existing workspace skills: ${refs}. ` +
      "Use action=update with skill_name for each existing skill instead.",
  );
}

function collectExistingWorkspaceSkillRefs(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  content: string;
}): string[] {
  const workspaceDir = path.resolve(params.workspaceDir);
  const normalizedContent = normalizePathText(params.content);
  if (!normalizedContent.includes("skills/")) {
    return [];
  }
  const workspaceSkillEntries = loadWorkspaceSkillEntries(workspaceDir, {
    config: params.config,
    workspaceOnly: true,
  });
  const projectAgentSkillEntries = normalizedContent.includes(".agents/skills")
    ? loadWorkspaceSkillEntries(workspaceDir, { config: params.config }).filter(
        (entry) => entry.skill.source === "agents-skills-project",
      )
    : [];
  const skillDirs = [...workspaceSkillEntries, ...projectAgentSkillEntries]
    .map((entry) => path.resolve(entry.skill.baseDir))
    .toSorted((a, b) => b.length - a.length);
  const refs = new Set<string>();
  for (const skillDir of skillDirs) {
    if (contentReferencesExistingSkillDir(normalizedContent, workspaceDir, skillDir)) {
      refs.add(formatWorkspaceSkillRef(workspaceDir, skillDir));
    }
  }
  return [...refs].toSorted((a, b) => a.localeCompare(b));
}

function contentReferencesExistingSkillDir(
  normalizedContent: string,
  workspaceDir: string,
  skillDir: string,
): boolean {
  for (const referencePrefix of skillReferencePrefixes(workspaceDir, skillDir)) {
    if (hasBoundedReference(normalizedContent, referencePrefix)) {
      return true;
    }
  }
  return false;
}

function skillReferencePrefixes(workspaceDir: string, skillDir: string): string[] {
  const relativePrefix = formatWorkspaceSkillRef(workspaceDir, skillDir);
  const absolutePrefix = ensureTrailingSlash(toPortablePath(skillDir));
  return uniqueStrings([
    relativePrefix,
    `./${relativePrefix}`,
    `a/${relativePrefix}`,
    `b/${relativePrefix}`,
    absolutePrefix,
    ...homeRelativeSkillReferencePrefixes(absolutePrefix),
    ...driveLetterSkillReferencePrefixes(absolutePrefix),
  ]);
}

function homeRelativeSkillReferencePrefixes(absolutePrefix: string): string[] {
  const home = resolveOsHomeDir();
  if (!home) {
    return [];
  }
  const homePrefix = ensureTrailingSlash(toPortablePath(path.resolve(home)));
  return absolutePrefix.startsWith(homePrefix)
    ? [`~/${absolutePrefix.slice(homePrefix.length)}`]
    : [];
}

function driveLetterSkillReferencePrefixes(absolutePrefix: string): string[] {
  if (/^[A-Za-z]:\//u.test(absolutePrefix)) {
    const alternateCase =
      absolutePrefix[0] === absolutePrefix[0].toUpperCase()
        ? absolutePrefix[0].toLowerCase()
        : absolutePrefix[0].toUpperCase();
    return [`${alternateCase}${absolutePrefix.slice(1)}`];
  }
  return absolutePrefix.startsWith("/") ? [`C:${absolutePrefix}`] : [];
}

function hasBoundedReference(content: string, referencePrefix: string): boolean {
  let index = content.indexOf(referencePrefix);
  while (index !== -1) {
    if (hasReferenceBoundary(content, index)) {
      return true;
    }
    index = content.indexOf(referencePrefix, index + 1);
  }
  return false;
}

function hasReferenceBoundary(content: string, index: number): boolean {
  return index === 0 || PATH_REFERENCE_BOUNDARY_CHARS.has(content[index - 1] ?? "");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizePathText(content: string): string {
  return content.replace(/\\/g, "/");
}

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function formatWorkspaceSkillRef(workspaceDir: string, skillDir: string): string {
  return `${path.relative(workspaceDir, skillDir).split(path.sep).join("/")}/`;
}
