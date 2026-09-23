// Source install helpers install skills from source directories and repositories.
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGitSource } from "../../infra/git-source.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { withInstallWorkspace } from "../../infra/install-source-utils.js";
import { isImmutableGitCommitRef, parseGitPluginSpec } from "../../plugins/git-install.js";
import type { InstallSafetyOverrides } from "../../plugins/install-security-scan.types.js";
import { resolveUserPath } from "../../utils.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import { installExtractedSkillRoot } from "./archive-install.js";
import { validateRequestedSkillSlug } from "./install-paths.js";
import { recordSkillSourceInstall, type SkillSourceOrigin } from "./source-install-metadata.js";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type SkillSourceInstallResult =
  | {
      ok: true;
      slug: string;
      targetDir: string;
      source: "path" | "git";
      git?: SkillSourceOrigin["git"];
    }
  | { ok: false; error: string };

function createGitCommandEnv(): NodeJS.ProcessEnv {
  return sanitizeHostExecEnv({
    baseEnv: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    blockPathOverrides: false,
  });
}

async function readSkillNameFromFrontmatter(skillDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const frontmatter = parseSkillFrontmatter(raw);
    return normalizeOptionalString(frontmatter.name) ?? null;
  } catch {
    return null;
  }
}

function resolveFallbackSlugFromPath(sourcePath: string): string {
  return path.basename(path.resolve(sourcePath)).trim();
}

async function resolveSkillInstallSlug(params: {
  sourceDir: string;
  fallbackLabel: string;
  slug?: string;
}): Promise<string> {
  const explicit = normalizeOptionalString(params.slug);
  if (explicit) {
    return validateRequestedSkillSlug(explicit);
  }

  const frontmatterName = await readSkillNameFromFrontmatter(params.sourceDir);
  if (frontmatterName) {
    try {
      return validateRequestedSkillSlug(frontmatterName);
    } catch {
      // Fall back to the source label when the display name is not a valid install slug.
    }
  }

  return validateRequestedSkillSlug(params.fallbackLabel);
}

async function copyGitWorktreeExport(params: {
  repoDir: string;
  exportDir: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fs.cp(params.repoDir, params.exportDir, {
      recursive: true,
      filter: (source) => !path.relative(params.repoDir, source).split(path.sep).includes(".git"),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to prepare git skill source: ${String(err)}` };
  }
}

async function installLocalSkillDir(params: {
  workspaceDir: string;
  sourceDir: string;
  sourceSpec: string;
  source: "path" | "git";
  fallbackLabel: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  git?: SkillSourceOrigin["git"];
}): Promise<SkillSourceInstallResult> {
  const slug = await resolveSkillInstallSlug({
    sourceDir: params.sourceDir,
    fallbackLabel: params.fallbackLabel,
    slug: params.slug,
  });
  const workspaceAccess = getAgentWorkspaceAccess(params.workspaceDir, "loadSkills");
  const access = workspaceAccess?.loadSkills ? workspaceAccess : undefined;
  if (access && !access.recordSkillSourceInstall) {
    return { ok: false, error: "Remote workspace skill source tracking is unavailable" };
  }
  const recordInstall = access?.recordSkillSourceInstall ?? recordSkillSourceInstall;
  const install = await installExtractedSkillRoot({
    workspaceDir: params.workspaceDir,
    slug,
    extractedRoot: params.sourceDir,
    mode: params.force ? "update" : "install",
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    policy: {
      config: params.config,
      onInstallPolicyWarning: params.onInstallPolicyWarning,
      installId: params.source,
      origin: {
        type: params.source,
        spec: params.sourceSpec,
        ...(params.git?.commit ? { commit: params.git.commit } : {}),
        ...(params.git?.ref ? { ref: params.git.ref } : {}),
      },
      source:
        params.source === "git"
          ? {
              kind: "git",
              authority: "third-party",
              mutable: !isImmutableGitCommitRef(params.git?.ref),
              network: true,
            }
          : { kind: "local-path", authority: "user", mutable: true, network: false },
      requestedSpecifier: params.sourceSpec,
    },
  });
  if (!install.ok) {
    return { ok: false, error: install.error };
  }

  await recordInstall({
    workspaceDir: params.workspaceDir,
    targetDir: install.targetDir,
    origin: {
      version: 1,
      source: params.source,
      spec: params.sourceSpec,
      slug,
      installedAt: Date.now(),
      ...(params.git ? { git: params.git } : {}),
    },
  });

  return {
    ok: true,
    slug,
    targetDir: install.targetDir,
    source: params.source,
    ...(params.git ? { git: params.git } : {}),
  };
}

async function installGitSkill(params: {
  workspaceDir: string;
  spec: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
}): Promise<SkillSourceInstallResult> {
  const parsed = parseGitPluginSpec(params.spec);
  if (!parsed) {
    return { ok: false, error: `Unsupported git skill spec: ${params.spec}` };
  }

  return await withInstallWorkspace("openclaw-git-skill-", async (tmpDir) => {
    const repoDir = path.join(tmpDir, "repo");
    const exportDir = path.join(tmpDir, "export");
    params.logger?.info?.(
      `Cloning ${sanitizeForLog(redactSensitiveUrlLikeString(parsed.label))}...`,
    );
    const acquired = await acquireGitSource({
      ...parsed,
      repoDir,
      refMode: "resolve-remote",
      timeoutMs: params.timeoutMs,
      commandEnv: () => ({ baseEnv: {}, env: createGitCommandEnv() }),
    });
    if (!acquired.ok) {
      return acquired;
    }

    const git = {
      url: redactSensitiveUrlLikeString(parsed.url),
      ...(parsed.ref ? { ref: parsed.ref } : {}),
      commit: acquired.commit,
      resolvedAt: new Date().toISOString(),
    };
    const exported = await copyGitWorktreeExport({ repoDir, exportDir });
    if (!exported.ok) {
      return exported;
    }

    return await installLocalSkillDir({
      workspaceDir: params.workspaceDir,
      sourceDir: exportDir,
      sourceSpec: redactSensitiveUrlLikeString(parsed.normalizedSpec),
      source: "git",
      fallbackLabel: path.basename(parsed.label),
      slug: params.slug,
      force: params.force,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      config: params.config,
      onInstallPolicyWarning: params.onInstallPolicyWarning,
      git,
    });
  });
}

async function installPathSkill(params: {
  workspaceDir: string;
  spec: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
}): Promise<SkillSourceInstallResult> {
  const sourceDir = resolveUserPath(params.spec);
  let stat;
  try {
    stat = await fs.stat(sourceDir);
  } catch {
    return { ok: false, error: `Skill path not found: ${sourceDir}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `Skill path is not a directory: ${sourceDir}` };
  }
  return await installLocalSkillDir({
    workspaceDir: params.workspaceDir,
    sourceDir,
    sourceSpec: params.spec,
    source: "path",
    fallbackLabel: resolveFallbackSlugFromPath(sourceDir),
    slug: params.slug,
    force: params.force,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    config: params.config,
    onInstallPolicyWarning: params.onInstallPolicyWarning,
  });
}

export function isSkillSourceInstallSpec(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.toLowerCase().startsWith("git:") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    path.isAbsolute(trimmed)
  );
}

export async function installSkillFromSource(params: {
  workspaceDir: string;
  spec: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
}): Promise<SkillSourceInstallResult> {
  const spec = params.spec.trim();
  if (spec.toLowerCase().startsWith("git:")) {
    return await installGitSkill({ ...params, spec });
  }
  return await installPathSkill({ ...params, spec });
}
