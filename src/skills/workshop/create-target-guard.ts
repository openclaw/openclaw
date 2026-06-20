import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOsHomeRelativePath } from "../../infra/home-dir.js";
import { isPathInside } from "../../infra/path-safety.js";
import { loadWorkspaceSkillEntries } from "../loading/workspace.js";

// Create proposals are for new skills; existing workspace skill paths must be
// updated through action=update so the live target hash/rollback guard applies.
const WORKSPACE_SKILL_PATH_REFERENCE_PATTERN =
  /(?:^|[\s"'`([{|<>])((?:(?:\.\/|[ab]\/)?(?:skills|\.agents\/skills))\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;
const ABSOLUTE_WORKSPACE_SKILL_PATH_REFERENCE_PATTERN =
  /(?:^|[\s"'`([{|<>])((?:~(?=\/)|\/)[^\s"'`)\]}|<>]*\/skills\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;

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
  const references = collectWorkspaceSkillPathReferences(params.content, workspaceDir);
  if (references.length === 0) {
    return [];
  }
  const workspaceSkillEntries = loadWorkspaceSkillEntries(workspaceDir, {
    config: params.config,
    workspaceOnly: true,
  });
  const projectAgentSkillEntries = referencesIncludeProjectAgentSkills(references, workspaceDir)
    ? loadWorkspaceSkillEntries(workspaceDir, { config: params.config }).filter(
        (entry) => entry.skill.source === "agents-skills-project",
      )
    : [];
  const skillDirs = [...workspaceSkillEntries, ...projectAgentSkillEntries]
    .map((entry) => path.resolve(entry.skill.baseDir))
    .toSorted((a, b) => b.length - a.length);
  const refs = new Set<string>();
  for (const reference of references) {
    const skillDir = skillDirs.find(
      (candidate) => reference === candidate || isPathInside(candidate, reference),
    );
    if (skillDir) {
      refs.add(formatWorkspaceSkillRef(workspaceDir, skillDir));
    }
  }
  return [...refs].sort((a, b) => a.localeCompare(b));
}

function collectWorkspaceSkillPathReferences(content: string, workspaceDir: string): string[] {
  const references = new Set<string>();
  const normalizedContent = content.replace(/\\/g, "/");
  for (const match of normalizedContent.matchAll(WORKSPACE_SKILL_PATH_REFERENCE_PATTERN)) {
    const reference = resolveWorkspacePathReference(workspaceDir, match[1] ?? "");
    if (reference) {
      references.add(reference);
    }
  }
  for (const match of normalizedContent.matchAll(ABSOLUTE_WORKSPACE_SKILL_PATH_REFERENCE_PATTERN)) {
    const reference = resolveWorkspacePathReference(workspaceDir, match[1] ?? "");
    if (reference) {
      references.add(reference);
    }
  }
  return [...references].sort((a, b) => a.localeCompare(b));
}

function resolveWorkspacePathReference(workspaceDir: string, rawReference: string): string | null {
  const reference = rawReference.replace(/^(?:\.\/|[ab]\/)/, "");
  if (reference.startsWith("~/") || path.isAbsolute(reference)) {
    const resolved = reference.startsWith("~/")
      ? resolveOsHomeRelativePath(reference)
      : path.resolve(reference);
    return resolved === workspaceDir || isPathInside(workspaceDir, resolved) ? resolved : null;
  }
  const parts = reference.split("/");
  const isProjectAgentSkill = parts[0] === ".agents" && parts[1] === "skills";
  if (isProjectAgentSkill ? parts.length < 4 : parts[0] !== "skills" || parts.length < 3) {
    return null;
  }
  if (
    parts.some((part, index) => {
      if (isProjectAgentSkill && index === 0 && part === ".agents") {
        return false;
      }
      return !part || part === "." || part === ".." || part.startsWith(".");
    })
  ) {
    return null;
  }
  return path.resolve(workspaceDir, ...parts);
}

function referencesIncludeProjectAgentSkills(
  references: readonly string[],
  workspaceDir: string,
): boolean {
  const projectAgentSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  return references.some(
    (reference) =>
      reference === projectAgentSkillsDir || isPathInside(projectAgentSkillsDir, reference),
  );
}

function formatWorkspaceSkillRef(workspaceDir: string, skillDir: string): string {
  return `${path.relative(workspaceDir, skillDir).split(path.sep).join("/")}/`;
}
