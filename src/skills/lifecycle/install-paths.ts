import path from "node:path";
import { resolveSafeInstallDir } from "../../infra/install-safe-path.js";

const VALID_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) > 0x7f) {
      return true;
    }
  }
  return false;
}

/** Normalizes a tracked slug without accepting traversal or path separators. */
export function normalizeTrackedSkillSlug(raw: string): string {
  const slug = raw.trim();
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

export function validateRequestedSkillSlug(raw: string): string {
  const slug = normalizeTrackedSkillSlug(raw);
  if (hasNonAscii(slug) || !VALID_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

export function resolveWorkspaceSkillInstallDir(workspaceDir: string, slug: string): string {
  const skillsDir = path.join(path.resolve(workspaceDir), "skills");
  const target = resolveSafeInstallDir({
    baseDir: skillsDir,
    id: slug,
    invalidNameMessage: "invalid skill target path",
  });
  if (!target.ok) {
    throw new Error(target.error);
  }
  return target.path;
}
