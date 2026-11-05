import fs from "node:fs/promises";
import path from "node:path";
import { stripFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists, root } from "../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginHookSkillChangedEvent } from "../../plugins/hook-skill.types.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import { resolveAgentSkillsRoot } from "../loading/skill-paths.js";
import type { SkillScanFinding } from "../security/scanner.js";
import { scanSkillFile, scanSupportFilePath } from "../security/skill-bundle-scan.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  snapshotCommittedSkillArtifactBestEffort,
} from "./skill-change-hook.js";
import {
  assertInsideSkillsRoot,
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
} from "./workspace-skill-write.js";

// Authoring operations for a skills root a caller owns, such as a plugin's per-agent
// `agentSkillsDir`. Path confinement, file limits, frontmatter rules and the security scan
// live here so every writer refuses the same content; committed changes refresh discovery
// and reach `skill_changed` observers exactly once.

export const SKILL_FILE = "SKILL.md";
export const MAX_SKILL_SUPPORT_FILE_BYTES = MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES;
/** The Agent Skills description limit. */
export const MAX_SKILL_DESCRIPTION_BYTES = 1024;
const DEFAULT_MAX_SKILL_BYTES = 1024 * 1024;
const PLAIN_SEGMENT = /^[^/\\]+$/u;
const noop = () => {};

export type SkillAuthoringFinding = SkillScanFinding;

export type SkillAuthoringErrorCode =
  | "invalid_path"
  | "path_escape"
  | "too_large"
  | "invalid_frontmatter"
  | "unsafe_content"
  | "no_skills_root";

/** Refusal whose message says what to change; `code` lets callers add their own guidance. */
export class SkillAuthoringError extends Error {
  override name = "SkillAuthoringError";
  readonly code: SkillAuthoringErrorCode;
  readonly finding?: SkillAuthoringFinding;

  constructor(
    code: SkillAuthoringErrorCode,
    message: string,
    options?: { cause?: unknown; finding?: SkillAuthoringFinding },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    if (options?.finding) {
      this.finding = options.finding;
    }
  }
}

function assertPlainSegment(value: string, label: string): void {
  if (!PLAIN_SEGMENT.test(value) || value === "." || value === "..") {
    throw new SkillAuthoringError("path_escape", `${label} "${value}" must be one plain name.`);
  }
}

/** One skill's directory, refused unless it stays inside the skills root through links. */
export function resolveSkillDir(skillsRoot: string, skillName: string): string {
  assertPlainSegment(skillName, "Skill name");
  const skillDir = path.join(skillsRoot, skillName);
  try {
    assertInsideSkillsRoot(skillsRoot, skillDir, "skill directory");
  } catch (error) {
    throw new SkillAuthoringError("path_escape", formatErrorMessage(error), { cause: error });
  }
  return skillDir;
}

/** `SKILL.md`, or a support path below assets/, examples/, references/, scripts/ or templates/. */
export function normalizeSkillFilePath(input: string | undefined): string {
  const trimmed = input?.trim();
  if (!trimmed || trimmed === SKILL_FILE) {
    return SKILL_FILE;
  }
  try {
    return normalizeWorkspaceSkillSupportPath(trimmed);
  } catch (error) {
    throw new SkillAuthoringError("invalid_path", formatErrorMessage(error), { cause: error });
  }
}

/** Bounded read that refuses links; null when the file does not exist. */
export async function readSkillDirFile(skillDir: string, filePath: string): Promise<string | null> {
  return filePath === SKILL_FILE
    ? await readWorkspaceSkillFile(path.join(skillDir, SKILL_FILE))
    : await readWorkspaceSupportFile({ skillDir, relativePath: filePath });
}

/** Regular files below one skill directory, SKILL.md first; links and dot entries are skipped. */
export async function listSkillDirFiles(
  skillDir: string,
): Promise<{ files: string[]; sizeBytes: number; updatedAtMs: number }> {
  const entries = await listDirectoryTreeStrict(skillDir, {
    // Dependencies and hidden metadata are not support files; never spend the inventory budget on them.
    skipDirectory: ({ dirent }) => dirent.name.startsWith(".") || dirent.name === "node_modules",
  });
  const files: string[] = [];
  let sizeBytes = 0;
  let updatedAtMs = 0;
  for (const { relativePath: relative, dirent: entry } of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const segments = relative.split(path.sep);
    if (segments.some((segment) => segment.startsWith("."))) {
      continue;
    }
    const stat = await fs.stat(path.join(skillDir, relative));
    sizeBytes += stat.size;
    updatedAtMs = Math.max(updatedAtMs, stat.mtimeMs);
    files.push(segments.join("/"));
  }
  files.sort((a, b) => (a === SKILL_FILE ? -1 : b === SKILL_FILE ? 1 : a.localeCompare(b)));
  return { files, sizeBytes, updatedAtMs: Math.trunc(updatedAtMs) };
}

export { parseSkillFrontmatter, resolveAgentSkillsRoot };

/** Lenient split for advisory reads: broken frontmatter yields an empty record, never a throw. */
export function splitSkillFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  let frontmatter: Record<string, string> = {};
  try {
    frontmatter = parseSkillFrontmatter(content);
  } catch {
    // Callers that need valid frontmatter use validateSkillFileContent.
  }
  return { frontmatter, body: stripFrontmatterBlock(content) };
}

function validateSkillMarkdown(skillName: string, content: string, maxSkillBytes: number): string {
  const sizeBytes = Buffer.byteLength(content);
  if (sizeBytes > maxSkillBytes) {
    throw new SkillAuthoringError(
      "too_large",
      `SKILL.md is ${sizeBytes} bytes; the limit is ${maxSkillBytes}.`,
    );
  }
  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseSkillFrontmatter(content);
  } catch (error) {
    throw new SkillAuthoringError(
      "invalid_frontmatter",
      `SKILL.md frontmatter is invalid (${formatErrorMessage(error)}). Start the file with:\n---\nname: ${skillName}\ndescription: <when to use this skill>\n---`,
      { cause: error },
    );
  }
  if (frontmatter.name?.trim() !== skillName) {
    throw new SkillAuthoringError(
      "invalid_frontmatter",
      `SKILL.md frontmatter must contain "name: ${skillName}" (the skill directory name); found ${frontmatter.name ? `"${frontmatter.name}"` : "no name"}.`,
    );
  }
  const description = frontmatter.description?.trim() ?? "";
  const descriptionBytes = Buffer.byteLength(description);
  if (descriptionBytes === 0 || descriptionBytes > MAX_SKILL_DESCRIPTION_BYTES) {
    throw new SkillAuthoringError(
      "invalid_frontmatter",
      `SKILL.md frontmatter "description" must be 1-${MAX_SKILL_DESCRIPTION_BYTES} bytes (found ${descriptionBytes}). Lead with the situations that should trigger the skill.`,
    );
  }
  return description;
}

/**
 * Validates one file's next content: support path shape, SKILL.md frontmatter or support size,
 * then the security scan. Returns the SKILL.md description. Throws SkillAuthoringError.
 */
export function validateSkillFileContent(params: {
  skillName: string;
  filePath: string;
  content: string;
  /** SKILL.md size limit; defaults to the 1 MiB read limit. */
  maxSkillBytes?: number;
}): { description?: string } {
  const { skillName, filePath, content } = params;
  if (filePath.split("/").includes("node_modules")) {
    throw new SkillAuthoringError(
      "invalid_path",
      "node_modules is not a skill support directory. Put authored files in scripts/ or references/ instead.",
    );
  }
  const isSkillFile = filePath === SKILL_FILE;
  const secretPath = isSkillFile ? undefined : scanSupportFilePath(filePath)[0];
  if (secretPath) {
    throw new SkillAuthoringError(
      "unsafe_content",
      `Refused: a file path in "${skillName}" looks like it contains a credential. Name the file after its topic (e.g. "references/api.md"); never store real secrets in skills.`,
      { finding: secretPath },
    );
  }
  const description = isSkillFile
    ? validateSkillMarkdown(skillName, content, params.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES)
    : undefined;
  if (!isSkillFile && Buffer.byteLength(content) > MAX_SKILL_SUPPORT_FILE_BYTES) {
    throw new SkillAuthoringError(
      "too_large",
      `${filePath} exceeds ${MAX_SKILL_SUPPORT_FILE_BYTES} bytes; split it into smaller files.`,
    );
  }
  const label = `${skillName}/${filePath}`;
  const finding = scanSkillFile(content, label).find((entry) => entry.severity === "critical");
  if (finding) {
    const fix =
      finding.ruleId === "literal-secret"
        ? "Replace the credential with a placeholder such as <API_KEY>; never store real secrets in skills."
        : "Remove or rewrite that line, then retry.";
    throw new SkillAuthoringError(
      "unsafe_content",
      `Refused: ${label} line ${finding.line} matches security rule "${finding.ruleId}" (${finding.message}). ${fix}`,
      { finding },
    );
  }
  return description === undefined ? {} : { description };
}

/** Validates, then writes one file of one skill inside the skills root. */
export async function writeSkillRootFile(params: {
  skillsRoot: string;
  skillName: string;
  filePath: string;
  content: string;
  maxSkillBytes?: number;
  /** Host-held authority; runs after awaited work and immediately before the write. */
  assertCurrent?: () => void;
}): Promise<{ description?: string }> {
  const assertCurrent = params.assertCurrent ?? noop;
  const filePath = normalizeSkillFilePath(params.filePath);
  const validated = validateSkillFileContent({ ...params, filePath });
  assertCurrent();
  await fs.mkdir(params.skillsRoot, { recursive: true });
  assertCurrent();
  const skillDir = resolveSkillDir(params.skillsRoot, params.skillName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillRoot = await root(skillDir);
  await skillRoot.write(filePath, params.content, {
    encoding: "utf8",
    mkdir: true,
    overwrite: true,
    assertBeforeMutation: assertCurrent,
  });
  return validated;
}

/** Removes one support file; SKILL.md goes only with the whole skill. */
export async function removeSkillRootFile(params: {
  skillsRoot: string;
  skillName: string;
  filePath: string;
  /** Host-held authority; runs immediately before the removal. */
  assertCurrent?: () => void;
}): Promise<void> {
  const filePath = normalizeSkillFilePath(params.filePath);
  if (filePath === SKILL_FILE) {
    throw new SkillAuthoringError(
      "invalid_path",
      "SKILL.md cannot be removed on its own; remove the whole skill instead.",
    );
  }
  await removePathWithinRoot({
    rootDir: resolveSkillDir(params.skillsRoot, params.skillName),
    relativePath: filePath,
    force: false,
    assertBeforeMutation: params.assertCurrent ?? noop,
  });
}

const log = createSubsystemLogger("skills/authoring");

/**
 * Runs one skill change, then refreshes skill discovery and dispatches `skill_changed` once
 * with the before/after artifacts. Serializing overlapping changes stays with the caller.
 * A failed `apply` dispatches nothing and leaves discovery as it was. `assertCurrent` runs
 * after each awaited step and immediately before the dispatch; discovery still refreshes for
 * files `apply` committed, because it mirrors the disk, not the caller.
 */
export async function commitSkillRootChange<T>(params: {
  config: OpenClawConfig;
  agentId: string;
  skillsRoot: string;
  skillName: string;
  source: PluginHookSkillChangedEvent["source"];
  /** Host-resolved plugin owner, reported with `source: "plugin"`. */
  pluginId?: string;
  apply: () => Promise<T>;
  /** Caller bookkeeping after discovery refresh; a throw skips the dispatch. */
  beforeDispatch?: (result: T) => Promise<void>;
  assertCurrent?: () => void;
}): Promise<T> {
  const assertCurrent = params.assertCurrent ?? noop;
  assertCurrent();
  const skillDir = resolveSkillDir(params.skillsRoot, params.skillName);
  const hooked = hasCommittedSkillChangeHooks();
  const snapshot = async () =>
    hooked && (await pathExists(path.join(skillDir, SKILL_FILE)))
      ? await snapshotCommittedSkillArtifactBestEffort({
          skillDir,
          skillKey: params.skillName,
          source: params.source,
        })
      : undefined;
  const before = await snapshot();
  assertCurrent();
  const result = await params.apply();
  const after = await snapshot();
  try {
    const { refreshSkillsDiscovery } = await import("../runtime/refresh.js");
    // `skills.changed` broadcasts this reason: a plugin's per-agent skills root is the
    // "workshop" discovery tier, so its commits keep the shipped "workshop" reason; other
    // authors use the existing generic "manual".
    await refreshSkillsDiscovery({
      config: params.config,
      reason: params.source === "workshop" || params.source === "plugin" ? "workshop" : "manual",
    });
  } catch (error) {
    log.warn(`Skill changed, but discovery refresh failed: ${formatErrorMessage(error)}`);
  }
  await params.beforeDispatch?.(result);
  if (before || after) {
    assertCurrent();
    await dispatchCommittedSkillChangeBestEffort({
      action: !before ? "created" : after ? "updated" : "removed",
      source: params.source,
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
      workspaceDir: resolveAgentWorkspaceDir(params.config, params.agentId),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
  }
  return result;
}
