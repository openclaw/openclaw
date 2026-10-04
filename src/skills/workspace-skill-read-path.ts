import path from "node:path";
import { URL } from "node:url";
import { resolveSkillFileHost, type SkillFileHost } from "./skill-file-host.js";

type SkillReadIdentity = {
  name?: string;
  filePath: string;
  baseDir?: string;
  fileHost?: SkillFileHost;
};

const WORKSPACE_SKILL_PROTOCOL = "workspace-skill:";
const WORKSPACE_SKILL_HOST = "workspace";

/** Keep model-facing workspace-host paths distinct from Gateway filesystem paths. */
export function resolveSkillReadPath(
  skill: SkillReadIdentity,
  fileHost: SkillFileHost | undefined = resolveSkillFileHost(skill),
): string {
  const name = skill.name?.trim();
  if (fileHost !== "workspace" || !name || skill.filePath.startsWith("node://")) {
    return skill.filePath;
  }
  return `${WORKSPACE_SKILL_PROTOCOL}//${WORKSPACE_SKILL_HOST}/${encodeURIComponent(name)}/SKILL.md`;
}

export function isWorkspaceSkillReadPath(value: string): boolean {
  return value.startsWith(`${WORKSPACE_SKILL_PROTOCOL}//${WORKSPACE_SKILL_HOST}/`);
}

/** Map an admitted virtual read path back to this skill's host-owned source tree. */
export function resolveWorkspaceSkillSourcePath(
  skill: SkillReadIdentity,
  requestedPath: string,
): string | undefined {
  const name = skill.name?.trim();
  if (
    resolveSkillFileHost(skill) !== "workspace" ||
    !name ||
    !skill.baseDir ||
    requestedPath.includes("\\")
  ) {
    return undefined;
  }
  const locator = URL.parse(requestedPath);
  if (
    !locator ||
    locator.protocol !== WORKSPACE_SKILL_PROTOCOL ||
    locator.hostname !== WORKSPACE_SKILL_HOST ||
    locator.username ||
    locator.password ||
    locator.port ||
    locator.search ||
    locator.hash
  ) {
    return undefined;
  }
  const encodedParts = locator.pathname.split("/").slice(1);
  if (encodedParts.length < 2) {
    return undefined;
  }
  let parts: string[];
  try {
    parts = encodedParts.map((part) => decodeURIComponent(part));
  } catch {
    return undefined;
  }
  if (
    parts[0] !== name ||
    parts.slice(1).some((part) => !part || part === "." || part === ".." || /[/\\\0]/u.test(part))
  ) {
    return undefined;
  }
  const relative = parts.slice(1);
  if (relative.length === 1 && relative[0] === "SKILL.md") {
    return skill.filePath;
  }
  const syntax =
    !skill.baseDir.startsWith("/") && path.win32.isAbsolute(skill.baseDir)
      ? path.win32
      : path.posix;
  if (!syntax.isAbsolute(skill.baseDir)) {
    return undefined;
  }
  const baseDir = syntax.resolve(skill.baseDir);
  const sourcePath = syntax.resolve(baseDir, ...relative);
  const containment = syntax.relative(baseDir, sourcePath);
  return containment &&
    !containment.startsWith(`..${syntax.sep}`) &&
    containment !== ".." &&
    !syntax.isAbsolute(containment)
    ? sourcePath
    : undefined;
}
