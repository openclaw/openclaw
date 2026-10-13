import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage, hasErrnoCode } from "../../infra/errors.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists, root } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  snapshotCommittedSkillArtifactBestEffort,
} from "../lifecycle/skill-change-hook.js";
import {
  assertInsideSkillsRoot,
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
} from "../lifecycle/workspace-skill-write.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { scanSkillFile, scanSupportFilePath } from "../security/skill-bundle-scan.js";
import { recordWorkshopChange } from "./changes.js";
import type { WorkshopActor, WorkshopChange } from "./changes.kernel.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  listVersions,
  pruneVersions,
  snapshotSkill,
  type MutationPaths,
  type SkillPaths,
  type SkillVersion,
  type WorkshopChangeAction,
} from "./skill-versions.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

export { listWorkshopChanges } from "./changes.js";

export type WorkshopMutationContext = {
  config: OpenClawConfig;
  agentId: string;
  actor: WorkshopActor;
  sessionKey?: string;
  runId?: string;
  /** Throws once the caller lost write authority; checked under the skill locks before any write. */
  assertLive?: () => void;
};
export type WorkshopSkillSummary = {
  name: string;
  description: string;
  updatedAtMs: number;
  sizeBytes: number;
  files: string[];
};
export type WorkshopArchivedSkill = {
  name: string;
  live: boolean;
  versions: SkillVersion[];
};

/** Refusal the model (or operator) can act on; the message says what to change. */
export class WorkshopWriteError extends Error {
  override name = "WorkshopWriteError";
}

const SKILL_FILE = "SKILL.md";
const ARCHIVE_DIR = ".archive";
// The Agent Skills limit. Authoring guidance asks for ~160 bytes, but a hard 160 cap forced
// lossy description rewrites whenever a review patched an older skill, and blocked restores.
const MAX_DESCRIPTION_BYTES = 1024;
// New names follow the Agent Skills limit. Earlier releases named learned skills with
// normalizeSkillIndexName and no length cap, so existing skills are matched by charset and
// the filesystem's 255-byte name limit only; otherwise they stay loaded but unmanageable.
const NEW_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EXISTING_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,254}$/;
const skillLocks = new KeyedAsyncQueue();

function emptyForMissingDirectory(error: unknown): never[] {
  if (hasErrnoCode(error, "ENOENT")) {
    return [];
  }
  throw error;
}

function resolveSkillPaths(config: OpenClawConfig, agentId: string, name: string): SkillPaths {
  if (!EXISTING_SKILL_NAME_PATTERN.test(name)) {
    throw new WorkshopWriteError(
      `Invalid skill name "${name}": use lowercase letters, digits, or hyphens, starting with a letter or digit (e.g. "deploy-staging").`,
    );
  }
  const skillsRoot = resolveWorkshopSkillsDir(config, agentId);
  return {
    root: skillsRoot,
    skillDir: path.join(skillsRoot, name),
    versionsDir: path.join(skillsRoot, ARCHIVE_DIR, name),
  };
}

function normalizeSkillFilePath(filePath: string | undefined): string {
  const trimmed = filePath?.trim();
  if (!trimmed || trimmed === SKILL_FILE) {
    return SKILL_FILE;
  }
  try {
    return normalizeWorkspaceSkillSupportPath(trimmed);
  } catch (error) {
    throw new WorkshopWriteError(
      `Invalid file_path "${trimmed}": ${formatErrorMessage(error)} Use "SKILL.md" or a file like "references/notes.md".`,
    );
  }
}

async function readSkillFile(skillDir: string, filePath: string): Promise<string | null> {
  return filePath === SKILL_FILE
    ? await readWorkspaceSkillFile(path.join(skillDir, SKILL_FILE))
    : await readWorkspaceSupportFile({ skillDir, relativePath: filePath });
}

/** Regular files below one skill directory, SKILL.md first; links and dot entries are skipped. */
async function listSkillFiles(
  skillDir: string,
): Promise<{ files: string[]; sizeBytes: number; updatedAtMs: number }> {
  const entries = await fs.readdir(skillDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  let sizeBytes = 0;
  let updatedAtMs = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const relative = path.relative(skillDir, path.join(entry.parentPath, entry.name));
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

function validateSkillMarkdown(name: string, content: string, maxSkillBytes: number): string {
  const sizeBytes = Buffer.byteLength(content);
  if (sizeBytes > maxSkillBytes) {
    throw new WorkshopWriteError(
      `SKILL.md is ${sizeBytes} bytes; the limit is ${maxSkillBytes}. Keep SKILL.md to the procedure and move detail into references/<topic>.md with action=write_file.`,
    );
  }
  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseSkillFrontmatter(content);
  } catch (error) {
    throw new WorkshopWriteError(
      `SKILL.md frontmatter is invalid (${formatErrorMessage(error)}). Start the file with:\n---\nname: ${name}\ndescription: <when to use this skill>\n---`,
    );
  }
  if (frontmatter.name?.trim() !== name) {
    throw new WorkshopWriteError(
      `SKILL.md frontmatter must contain "name: ${name}" (the skill directory name); found ${frontmatter.name ? `"${frontmatter.name}"` : "no name"}.`,
    );
  }
  const description = frontmatter.description?.trim() ?? "";
  const descriptionBytes = Buffer.byteLength(description);
  if (descriptionBytes === 0 || descriptionBytes > MAX_DESCRIPTION_BYTES) {
    throw new WorkshopWriteError(
      `SKILL.md frontmatter "description" must be 1-${MAX_DESCRIPTION_BYTES} bytes (found ${descriptionBytes}). Lead with the situations that should trigger the skill.`,
    );
  }
  return description;
}

function assertSafeContent(name: string, filePath: string, content: string): void {
  const label = `${name}/${filePath}`;
  const finding = scanSkillFile(content, label).find((entry) => entry.severity === "critical");
  if (!finding) {
    return;
  }
  const fix =
    finding.ruleId === "literal-secret"
      ? "Replace the credential with a placeholder such as <API_KEY>; never store real secrets in skills."
      : "Remove or rewrite that line, then retry.";
  throw new WorkshopWriteError(
    `Refused: ${label} line ${finding.line} matches security rule "${finding.ruleId}" (${finding.message}). ${fix}`,
  );
}

/** Validates one file's next content: path, SKILL.md shape or support size, then the security scan. */
function validateSkillFile(
  config: OpenClawConfig,
  name: string,
  filePath: string,
  content: string,
): string | undefined {
  if (filePath !== SKILL_FILE && scanSupportFilePath(filePath).length > 0) {
    throw new WorkshopWriteError(
      `Refused: a file path in "${name}" looks like it contains a credential. Name the file after its topic (e.g. "references/api.md"); never store real secrets in skills.`,
    );
  }
  const description =
    filePath === SKILL_FILE
      ? validateSkillMarkdown(name, content, resolveSkillWorkshopConfig(config).maxSkillBytes)
      : undefined;
  if (
    filePath !== SKILL_FILE &&
    Buffer.byteLength(content) > MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES
  ) {
    throw new WorkshopWriteError(
      `${filePath} exceeds ${MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES} bytes; split it into smaller files.`,
    );
  }
  assertSafeContent(name, filePath, content);
  return description;
}

/** Reads a saved version only when a normal write could have produced every file in it. */
async function readRestorableVersion(
  config: OpenClawConfig,
  name: string,
  versionId: string,
  versionDir: string,
): Promise<Array<[string, Buffer]>> {
  const refuse = (problem: string) =>
    new WorkshopWriteError(
      `Cannot restore "${name}" version ${versionId}: ${problem} The live skill is unchanged; restore a different version instead.`,
    );
  if (!(await fs.lstat(versionDir)).isDirectory()) {
    throw refuse("the saved version is not a directory.");
  }
  const versionRoot = await root(versionDir);
  const files: Array<[string, Buffer]> = [];
  for (const entry of await fs.readdir(versionDir, { recursive: true, withFileTypes: true })) {
    const filePath = path
      .relative(versionDir, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    // Dot entries (e.g. .DS_Store) are not part of a skill and are never restored.
    if (entry.isDirectory() || filePath.split("/").some((segment) => segment.startsWith("."))) {
      continue;
    }
    if (!entry.isFile()) {
      throw refuse(`${filePath} is a symlink or special file.`);
    }
    if (filePath !== SKILL_FILE) {
      let canonical: string;
      try {
        canonical = normalizeWorkspaceSkillSupportPath(filePath);
      } catch (error) {
        throw refuse(`${filePath} is not an allowed skill file (${formatErrorMessage(error)})`);
      }
      // Restored files must stay addressable by view/patch, which use the canonical path.
      if (canonical !== filePath) {
        throw refuse(`${filePath} is not a canonical skill file path.`);
      }
    }
    let content: Buffer;
    try {
      content = (
        await versionRoot.read(filePath, {
          hardlinks: "reject",
          maxBytes:
            filePath === SKILL_FILE
              ? resolveSkillWorkshopConfig(config).maxSkillBytes
              : MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
          symlinks: "reject",
        })
      ).buffer;
    } catch (error) {
      throw refuse(`${filePath} could not be read safely (${formatErrorMessage(error)}).`);
    }
    try {
      validateSkillFile(config, name, filePath, content.toString("utf8"));
    } catch (error) {
      throw refuse(formatErrorMessage(error));
    }
    files.push([filePath, content]);
  }
  if (!files.some(([filePath]) => filePath === SKILL_FILE)) {
    throw refuse("SKILL.md is missing.");
  }
  return files;
}

async function writeSkillFile(paths: MutationPaths, filePath: string, content: string) {
  await fs.mkdir(paths.root, { recursive: true });
  assertInsideSkillsRoot(paths.root, paths.skillDir, "skill directory");
  await fs.mkdir(paths.skillDir, { recursive: true });
  const skillRoot = await root(paths.skillDir);
  await skillRoot.write(filePath, content, {
    encoding: "utf8",
    mkdir: true,
    overwrite: true,
    assertBeforeMutation: paths.assertLive,
  });
}

async function requireLiveSkill(paths: SkillPaths, name: string): Promise<void> {
  if (await pathExists(path.join(paths.skillDir, SKILL_FILE))) {
    return;
  }
  const archived = (await listVersions(paths.versionsDir)).length > 0;
  throw new WorkshopWriteError(
    archived
      ? `Skill "${name}" is archived. Restore it first with action=restore name=${name}.`
      : `No workshop skill named "${name}". Call action=list to see skills, or action=create to add one.`,
  );
}

/** Sorted acquisition keeps overlapping multi-skill mutations from deadlocking. */
async function withSkillLocks<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(keys)].toSorted((a, b) => a.localeCompare(b));
  return first === undefined
    ? await run()
    : await skillLocks.enqueue(first, () => withSkillLocks(rest, run));
}

/** Serializes one skill's mutation, then publishes the snapshot bump and change row. */
async function mutateSkill(
  ctx: WorkshopMutationContext,
  name: string,
  action: WorkshopChangeAction,
  apply: (paths: MutationPaths) => Promise<{ summary: string; versionId?: string }>,
  alsoLock: readonly SkillPaths[] = [],
): Promise<WorkshopChange> {
  const paths = resolveSkillPaths(ctx.config, ctx.agentId, name);
  const lockKeys = [paths.skillDir, ...alsoLock.map((other) => other.skillDir)];
  return await withSkillLocks(lockKeys, async () => {
    ctx.assertLive?.();
    // Plugin skill_changed observers see Workshop edits like any committed skill change.
    const hooked = hasCommittedSkillChangeHooks();
    const snapshotArtifact = async () =>
      hooked && (await pathExists(path.join(paths.skillDir, SKILL_FILE)))
        ? await snapshotCommittedSkillArtifactBestEffort({
            skillDir: paths.skillDir,
            skillKey: name,
            source: "workshop",
          })
        : undefined;
    const before = await snapshotArtifact();
    // Checked at lock time to skip needless work, and again right before each file effect.
    const { summary, versionId } = await apply({ ...paths, assertLive: () => ctx.assertLive?.() });
    const after = await snapshotArtifact();
    await pruneVersions(paths.versionsDir);
    bumpSkillsSnapshotVersion({
      reason: "workshop",
      changedPath: path.join(paths.skillDir, SKILL_FILE),
    });
    const change: WorkshopChange = {
      id: randomUUID(),
      agentId: ctx.agentId,
      skillName: name,
      action,
      actor: ctx.actor,
      summary,
      ...(versionId ? { versionId } : {}),
      ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      createdAtMs: Date.now(),
    };
    await recordWorkshopChange(change);
    if (before || after) {
      await dispatchCommittedSkillChangeBestEffort({
        action: !before ? "created" : after ? "updated" : "removed",
        source: "workshop",
        workspaceDir: resolveAgentWorkspaceDir(ctx.config, ctx.agentId),
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      });
    }
    return change;
  });
}

export async function listWorkshopSkills(
  config: OpenClawConfig,
  agentId: string,
): Promise<WorkshopSkillSummary[]> {
  const skillsRoot = resolveWorkshopSkillsDir(config, agentId);
  const entries = await fs
    .readdir(skillsRoot, { withFileTypes: true })
    .catch(emptyForMissingDirectory);
  const skills: WorkshopSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !EXISTING_SKILL_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const skillDir = path.join(skillsRoot, entry.name);
    const content = await readWorkspaceSkillFile(path.join(skillDir, SKILL_FILE)).catch(() => null);
    if (content === null) {
      continue;
    }
    let description = "";
    try {
      description = parseSkillFrontmatter(content).description?.trim() ?? "";
    } catch {
      // A hand-edited skill with broken frontmatter still lists; view shows the file.
    }
    skills.push({ name: entry.name, description, ...(await listSkillFiles(skillDir)) });
  }
  return skills.toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function listWorkshopArchive(
  config: OpenClawConfig,
  agentId: string,
): Promise<WorkshopArchivedSkill[]> {
  const skillsRoot = resolveWorkshopSkillsDir(config, agentId);
  const names: string[] = await fs
    .readdir(path.join(skillsRoot, ARCHIVE_DIR))
    .catch(emptyForMissingDirectory);
  const archived: WorkshopArchivedSkill[] = [];
  for (const name of names.toSorted()) {
    if (!EXISTING_SKILL_NAME_PATTERN.test(name)) {
      continue;
    }
    const versions = await listVersions(path.join(skillsRoot, ARCHIVE_DIR, name));
    if (versions.length > 0) {
      const live = await pathExists(path.join(skillsRoot, name, SKILL_FILE));
      archived.push({ name, live, versions });
    }
  }
  return archived;
}

export async function viewWorkshopSkill(
  config: OpenClawConfig,
  agentId: string,
  name: string,
  filePath?: string,
  versionId?: string,
): Promise<{ name: string; filePath: string; content: string; files: string[] }> {
  const paths = resolveSkillPaths(config, agentId, name);
  const file = normalizeSkillFilePath(filePath);
  let baseDir = paths.skillDir;
  if (versionId) {
    const versions = await listVersions(paths.versionsDir);
    if (!versions.some((version) => version.id === versionId)) {
      throw new WorkshopWriteError(
        `Skill "${name}" has no version "${versionId}". Versions: ${versions.map((version) => version.id).join(", ") || "none"}.`,
      );
    }
    baseDir = path.join(paths.versionsDir, versionId);
  } else {
    await requireLiveSkill(paths, name);
  }
  const { files } = await listSkillFiles(baseDir);
  const content = await readSkillFile(baseDir, file);
  if (content === null) {
    throw new WorkshopWriteError(
      `${file} does not exist in "${name}". Files: ${files.join(", ")}.`,
    );
  }
  return { name, filePath: file, content, files };
}

export async function createWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: { name: string; content: string; summary?: string },
): Promise<WorkshopChange> {
  if (!NEW_SKILL_NAME_PATTERN.test(params.name)) {
    throw new WorkshopWriteError(
      `Invalid skill name "${params.name}": use 1-63 lowercase letters, digits, or hyphens, starting with a letter or digit (e.g. "deploy-staging").`,
    );
  }
  return await mutateSkill(ctx, params.name, "create", async (paths) => {
    if (await pathExists(paths.skillDir)) {
      throw new WorkshopWriteError(
        `Skill "${params.name}" already exists. View it and use action=patch, or choose another name.`,
      );
    }
    const description = validateSkillFile(ctx.config, params.name, SKILL_FILE, params.content);
    try {
      await writeSkillFile(paths, SKILL_FILE, params.content);
    } catch (error) {
      await fs.rm(paths.skillDir, { recursive: true, force: true });
      throw error;
    }
    return { summary: params.summary ?? `created: ${description}` };
  });
}

export async function patchWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: { name: string; oldText: string; newText: string; filePath?: string; summary?: string },
): Promise<WorkshopChange> {
  const file = normalizeSkillFilePath(params.filePath);
  return await mutateSkill(ctx, params.name, "patch", async (paths) => {
    await requireLiveSkill(paths, params.name);
    if (!params.oldText) {
      throw new WorkshopWriteError(
        "old_text is required: copy the exact text to replace from view.",
      );
    }
    if (params.oldText === params.newText) {
      throw new WorkshopWriteError("old_text and new_text are identical; nothing to change.");
    }
    const current = await readSkillFile(paths.skillDir, file);
    if (current === null) {
      throw new WorkshopWriteError(
        `${file} does not exist in "${params.name}". Use action=write_file to add it.`,
      );
    }
    const { oldText } = params;
    let matches = 0;
    for (let at = current.indexOf(oldText); at !== -1; at = current.indexOf(oldText, at + 1)) {
      matches++;
    }
    if (matches !== 1) {
      throw new WorkshopWriteError(
        matches === 0
          ? `old_text was not found in ${params.name}/${file}. View the file again and copy the exact text, including whitespace.`
          : `old_text matches ${matches} places in ${params.name}/${file}. Include more surrounding text so it matches once.`,
      );
    }
    const next = current.replace(params.oldText, () => params.newText);
    validateSkillFile(ctx.config, params.name, file, next);
    const versionId = await snapshotSkill(paths, "patch");
    await writeSkillFile(paths, file, next);
    return { summary: params.summary ?? `patched ${file}`, versionId };
  });
}

export async function writeWorkshopSkillFile(
  ctx: WorkshopMutationContext,
  params: { name: string; filePath: string; content: string; summary?: string },
): Promise<WorkshopChange> {
  const file = normalizeSkillFilePath(params.filePath);
  return await mutateSkill(ctx, params.name, "write_file", async (paths) => {
    await requireLiveSkill(paths, params.name);
    if ((await readSkillFile(paths.skillDir, file)) === params.content) {
      throw new WorkshopWriteError(
        `${params.name}/${file} already has this content; nothing changed.`,
      );
    }
    validateSkillFile(ctx.config, params.name, file, params.content);
    const versionId = await snapshotSkill(paths, "write_file");
    await writeSkillFile(paths, file, params.content);
    return {
      summary: params.summary ?? (file === SKILL_FILE ? "rewrote SKILL.md" : `wrote ${file}`),
      versionId,
    };
  });
}

/** Deletes one support file; SKILL.md goes only with the whole skill, through archive. */
export async function removeWorkshopSkillFile(
  ctx: WorkshopMutationContext,
  params: { name: string; filePath: string; summary?: string },
): Promise<WorkshopChange> {
  const file = normalizeSkillFilePath(params.filePath);
  if (file === SKILL_FILE) {
    throw new WorkshopWriteError(
      `SKILL.md cannot be removed. Archive the skill with action=archive name=${params.name} instead.`,
    );
  }
  return await mutateSkill(ctx, params.name, "remove_file", async (paths) => {
    await requireLiveSkill(paths, params.name);
    const { files } = await listSkillFiles(paths.skillDir);
    if (!files.includes(file)) {
      throw new WorkshopWriteError(
        `${file} does not exist in "${params.name}". Files: ${files.join(", ")}.`,
      );
    }
    const versionId = await snapshotSkill(paths, "remove_file");
    await removePathWithinRoot({
      rootDir: paths.skillDir,
      relativePath: file,
      force: false,
      assertBeforeMutation: paths.assertLive,
    });
    return { summary: params.summary ?? `removed ${file}`, versionId };
  });
}

export async function archiveWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: { name: string; absorbedInto?: string; reason?: string },
): Promise<WorkshopChange> {
  const absorbedInto =
    params.absorbedInto === undefined
      ? undefined
      : resolveSkillPaths(ctx.config, ctx.agentId, params.absorbedInto);
  // The target stays locked until the source is gone, so it cannot be archived mid-merge.
  return await mutateSkill(
    ctx,
    params.name,
    "archive",
    async (paths) => {
      await requireLiveSkill(paths, params.name);
      if (
        absorbedInto &&
        (params.absorbedInto === params.name ||
          !(await pathExists(path.join(absorbedInto.skillDir, SKILL_FILE))))
      ) {
        throw new WorkshopWriteError(
          `absorbed_into must name another live workshop skill; "${params.absorbedInto}" is not one.`,
        );
      }
      const versionId = await snapshotSkill(paths, "archive");
      // One fenced rename takes the skill out of service, so a refusal leaves it whole.
      const detached = path.join(paths.root, ARCHIVE_DIR, `.archiving-${randomUUID()}`);
      paths.assertLive();
      await fs.rename(paths.skillDir, detached);
      await fs.rm(detached, { recursive: true, force: true });
      const detail = [
        params.absorbedInto ? `merged into ${params.absorbedInto}` : undefined,
        params.reason?.trim() || undefined,
      ].filter(Boolean);
      return {
        summary: detail.length > 0 ? `archived: ${detail.join("; ")}` : "archived",
        versionId,
      };
    },
    absorbedInto ? [absorbedInto] : [],
  );
}

/** Restores a saved version (default: newest); the live copy is versioned first, so undo is undoable. */
export async function restoreWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: { name: string; versionId?: string; summary?: string },
): Promise<WorkshopChange> {
  return await mutateSkill(ctx, params.name, "restore", async (paths) => {
    const versions = await listVersions(paths.versionsDir);
    const target = params.versionId
      ? versions.find((version) => version.id === params.versionId)
      : versions[0];
    if (!target) {
      throw new WorkshopWriteError(
        versions.length === 0
          ? `Skill "${params.name}" has no saved versions to restore.`
          : `Skill "${params.name}" has no version "${params.versionId}". Versions: ${versions.map((version) => version.id).join(", ")}.`,
      );
    }
    const files = await readRestorableVersion(
      ctx.config,
      params.name,
      target.id,
      path.join(paths.versionsDir, target.id),
    );
    const staging = path.join(paths.root, ARCHIVE_DIR, `.restore-${randomUUID()}`);
    const previous = path.join(paths.root, ARCHIVE_DIR, `.restore-previous-${randomUUID()}`);
    try {
      for (const [filePath, content] of files) {
        const destination = path.join(staging, ...filePath.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content, { flag: "wx" });
      }
      const versionId = await snapshotSkill(paths, "restore");
      // Swap by rename so a refused or failed publish puts the previous live skill back.
      const hadLive = await pathExists(paths.skillDir);
      if (hadLive) {
        paths.assertLive();
        await fs.rename(paths.skillDir, previous);
      }
      try {
        paths.assertLive();
        await fs.rename(staging, paths.skillDir);
      } catch (error) {
        if (hadLive) {
          await fs.rename(previous, paths.skillDir);
        }
        throw error;
      }
      const summary =
        params.summary ??
        (target.action === "archive"
          ? "restored from archive"
          : params.versionId
            ? `restored version ${target.id}`
            : `undid ${target.action.replace("_", " ")}`);
      return { summary, versionId };
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rm(previous, { recursive: true, force: true });
    }
  });
}
