import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ignoreMissingPath } from "../../infra/errno.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists, root } from "../../infra/fs-safe.js";
import {
  assertInsideSkillsRoot,
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
} from "../lifecycle/workspace-skill-write.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  EXISTING_SKILL_NAME_PATTERN,
  listSkillFiles,
  mutateSkill,
  NEW_SKILL_NAME_PATTERN,
  normalizeSkillFilePath,
  readSkillFile,
  SKILL_FILE,
  validateSkillFile,
  WorkshopWriteError,
  publishSkillBundle,
  writeStagedFile,
  type WorkshopMutationContext,
} from "./library.js";
import { resolveWorkshopDraftsDir, resolveWorkshopSkillsDir } from "./skills-root.js";

// Drafts are proposed skills a background review saved instead of changing live skills.
// They are plain directories (`<id>/SKILL.md` plus support files) that discovery never
// loads; Doctor exports retired proposal drafts here in the same shape.
const REASON_FILE = ".reason";
// Matches retired proposal ids, so their exports are drafts as-is.
const DRAFT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/u;
// An unreviewed inbox past this size is not being read; refuse instead of growing it.
const MAX_DRAFTS = 50;

export type WorkshopDraft = {
  id: string;
  /** Frontmatter name of the drafted SKILL.md: the skill it creates or replaces. */
  skillName: string;
  description: string;
  reason?: string;
  createdAtMs: number;
  files: string[];
};

function resolveDraftDir(config: OpenClawConfig, agentId: string, id: string): string {
  if (!DRAFT_ID_PATTERN.test(id)) {
    throw new WorkshopWriteError(`Invalid draft id "${id}". Call action=list to see drafts.`);
  }
  return path.join(resolveWorkshopDraftsDir(config, agentId), id);
}

async function readDraft(draftsDir: string, id: string): Promise<WorkshopDraft | undefined> {
  const draftDir = path.join(draftsDir, id);
  const content = await readSkillFile(draftDir, SKILL_FILE).catch(() => null);
  if (content === null) {
    return undefined;
  }
  let frontmatter: Record<string, string> = {};
  try {
    frontmatter = parseSkillFrontmatter(content);
  } catch {
    // A draft with broken frontmatter still lists; view shows the file.
  }
  const reason = (
    await fs.readFile(path.join(draftDir, REASON_FILE), "utf8").catch(() => "")
  ).trim();
  const { files, updatedAtMs } = await listSkillFiles(draftDir);
  return {
    id,
    skillName: frontmatter.name?.trim() || id,
    description: frontmatter.description?.trim() ?? "",
    ...(reason ? { reason } : {}),
    createdAtMs: updatedAtMs,
    files,
  };
}

/** Drafts waiting for review, oldest first. */
export async function listWorkshopDrafts(
  config: OpenClawConfig,
  agentId: string,
): Promise<WorkshopDraft[]> {
  const draftsDir = resolveWorkshopDraftsDir(config, agentId);
  const entries = await fs
    .readdir(draftsDir, { withFileTypes: true })
    .catch((error: unknown) => ignoreMissingPath(error) ?? []);
  const drafts: WorkshopDraft[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && DRAFT_ID_PATTERN.test(entry.name)) {
      const draft = await readDraft(draftsDir, entry.name);
      if (draft) {
        drafts.push(draft);
      }
    }
  }
  return drafts.toSorted((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
}

/** Saves a proposed SKILL.md for later review and returns its id; live skills stay unchanged. */
export async function saveWorkshopDraft(
  config: OpenClawConfig,
  agentId: string,
  params: { name: string; content: string; reason?: string; assertLive?: () => void },
): Promise<string> {
  if (!EXISTING_SKILL_NAME_PATTERN.test(params.name)) {
    throw new WorkshopWriteError(
      `Invalid skill name "${params.name}": use lowercase letters, digits, or hyphens (e.g. "deploy-staging").`,
    );
  }
  validateSkillFile(config, params.name, SKILL_FILE, params.content);
  if ((await listWorkshopDrafts(config, agentId)).length >= MAX_DRAFTS) {
    throw new WorkshopWriteError(
      `${MAX_DRAFTS} drafts are already waiting for review. Save nothing; the user reviews drafts with /learn drafts.`,
    );
  }
  const draftsDir = resolveWorkshopDraftsDir(config, agentId);
  const id = `${params.name.slice(0, 60).replace(/-+$/u, "")}-${randomUUID().slice(0, 8)}`;
  await fs.mkdir(draftsDir, { recursive: true });
  // A symlinked .drafts must not carry writes outside the Workshop directory.
  assertInsideSkillsRoot(resolveWorkshopSkillsDir(config, agentId), draftsDir, "drafts directory");
  const drafts = await root(draftsDir);
  const write = async (filePath: string, content: string) =>
    await drafts.write(`${id}/${filePath}`, content, {
      encoding: "utf8",
      mkdir: true,
      overwrite: false,
      ...(params.assertLive ? { assertBeforeMutation: params.assertLive } : {}),
    });
  // The reason goes first: a draft is listed once its SKILL.md exists.
  const reason = params.reason?.trim();
  if (reason) {
    await write(REASON_FILE, `${reason}\n`);
  }
  await write(SKILL_FILE, params.content);
  return id;
}

export async function viewWorkshopDraft(
  config: OpenClawConfig,
  agentId: string,
  id: string,
  filePath?: string,
): Promise<{ draft: WorkshopDraft; filePath: string; content: string }> {
  const draftDir = resolveDraftDir(config, agentId, id);
  const draft = await readDraft(path.dirname(draftDir), id);
  if (!draft) {
    throw new WorkshopWriteError(`No draft "${id}". Call action=list to see drafts.`);
  }
  const file = normalizeSkillFilePath(filePath);
  const content = await readSkillFile(draftDir, file);
  if (content === null) {
    throw new WorkshopWriteError(
      `${file} does not exist in draft "${id}". Files: ${draft.files.join(", ")}.`,
    );
  }
  return { draft, filePath: file, content };
}

/** Deletes a reviewed draft, whether its lesson was saved or rejected. */
export async function discardWorkshopDraft(
  config: OpenClawConfig,
  agentId: string,
  id: string,
  assertLive?: () => void,
): Promise<void> {
  const draftDir = resolveDraftDir(config, agentId, id);
  if (!(await pathExists(draftDir))) {
    throw new WorkshopWriteError(`No draft "${id}". Call action=list to see drafts.`);
  }
  await removePathWithinRoot({
    rootDir: path.dirname(draftDir),
    relativePath: id,
    recursive: true,
    force: false,
    ...(assertLive ? { assertBeforeMutation: assertLive } : {}),
  });
}

/**
 * Makes a draft the live skill in one versioned change, then deletes the draft. Every file is
 * validated first and the whole next skill is published by one staged swap, so a refused file or
 * failed write leaves the skill untouched, and one undo restores it as it was before the draft.
 */
export async function applyWorkshopDraft(
  ctx: WorkshopMutationContext,
  id: string,
  expectedSkillName?: string,
): Promise<WorkshopChange[]> {
  const draftDir = resolveDraftDir(ctx.config, ctx.agentId, id);
  const draft = await readDraft(path.dirname(draftDir), id);
  if (!draft) {
    throw new WorkshopWriteError(`No draft "${id}".`);
  }
  if (expectedSkillName !== undefined && expectedSkillName !== draft.skillName) {
    throw new WorkshopWriteError(
      `Draft "${id}" is for skill "${draft.skillName}", not "${expectedSkillName}". Reload the drafts.`,
    );
  }
  const name = draft.skillName;
  const skillDir = path.join(resolveWorkshopSkillsDir(ctx.config, ctx.agentId), name);
  const live =
    EXISTING_SKILL_NAME_PATTERN.test(name) && (await pathExists(path.join(skillDir, SKILL_FILE)));
  if (!(live ? EXISTING_SKILL_NAME_PATTERN : NEW_SKILL_NAME_PATTERN).test(name)) {
    throw new WorkshopWriteError(
      `Draft "${id}" names no valid skill; its SKILL.md frontmatter needs a name like "deploy-staging".`,
    );
  }
  // Bytes, not text: support assets such as images must publish exactly as drafted.
  const draftRoot = await root(draftDir);
  const files: Array<[string, Buffer]> = [];
  for (const file of draft.files) {
    const content = (
      await draftRoot.read(file, {
        hardlinks: "reject",
        symlinks: "reject",
        maxBytes:
          file === SKILL_FILE
            ? resolveSkillWorkshopConfig(ctx.config).maxSkillBytes
            : MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
      })
    ).buffer;
    validateSkillFile(ctx.config, name, file, content.toString("utf8"));
    const liveContent = await fs.readFile(path.join(skillDir, file)).catch(() => null);
    if (!liveContent?.equals(content)) {
      files.push([file, content]);
    }
  }
  const summary = draft.reason ?? "applied a draft";
  const changes =
    files.length === 0
      ? []
      : [
          await mutateSkill(ctx, name, live ? "write_file" : "create", async (paths) => {
            const exists = await pathExists(
              live ? path.join(paths.skillDir, SKILL_FILE) : paths.skillDir,
            );
            if (exists !== live) {
              throw new WorkshopWriteError(
                `Skill "${name}" changed while the draft was being applied; open the draft again.`,
              );
            }
            const versionId = await publishSkillBundle(paths, "write_file", async (staging) => {
              // The live copy carries unchanged files, binary assets included, byte for byte.
              if (live) {
                await fs.cp(paths.skillDir, staging, {
                  recursive: true,
                  filter: async (source) => !(await fs.lstat(source)).isSymbolicLink(),
                });
              }
              for (const [file, content] of files) {
                await writeStagedFile(staging, file, content);
              }
            });
            return { summary, ...(versionId ? { versionId } : {}) };
          }),
        ];
  await discardWorkshopDraft(ctx.config, ctx.agentId, id, ctx.assertLive);
  return changes;
}
