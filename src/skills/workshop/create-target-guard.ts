import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-safety.js";
import { loadWorkspaceSkillEntries } from "../loading/workspace.js";

// Create proposals are for new skills; existing workspace skill paths must be
// updated through action=update so the live target hash/rollback guard applies.
const WORKSPACE_SKILL_PATH_REFERENCE_PATTERN =
  /(?:^|[\s"'`([{|<])((?:(?:\.\/|[ab]\/)?skills)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;

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
  const skillDirs = loadWorkspaceSkillEntries(workspaceDir, {
    config: params.config,
    workspaceOnly: true,
  })
    .map((entry) => path.resolve(entry.skill.baseDir))
    .toSorted((a, b) => b.length - a.length);
  const refs = new Set<string>();
  for (const reference of collectWorkspaceSkillPathReferences(params.content, workspaceDir)) {
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
  for (const match of content.matchAll(WORKSPACE_SKILL_PATH_REFERENCE_PATTERN)) {
    const reference = resolveWorkspacePathReference(workspaceDir, match[1] ?? "");
    if (reference) {
      references.add(reference);
    }
  }
  return [...references].sort((a, b) => a.localeCompare(b));
}

function resolveWorkspacePathReference(workspaceDir: string, rawReference: string): string | null {
  const reference = rawReference.replace(/^(?:\.\/|[ab]\/)/, "");
  const parts = reference.split("/");
  if (parts[0] !== "skills" || parts.length < 3) {
    return null;
  }
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    return null;
  }
  return path.resolve(workspaceDir, ...parts);
}

function formatWorkspaceSkillRef(workspaceDir: string, skillDir: string): string {
  return `${path.relative(workspaceDir, skillDir).split(path.sep).join("/")}/`;
}
