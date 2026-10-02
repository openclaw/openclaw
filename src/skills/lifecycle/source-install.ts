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
import {
  loadSingleSkillDirectory,
  type LocalSkillLoadDiagnostic,
} from "../loading/local-loader.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import { installExtractedSkillRoot } from "./archive-install.js";
import { validateRequestedSkillSlug } from "./install-paths.js";
import { recordSkillSourceInstall, type SkillSourceOrigin } from "./source-install-metadata.js";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type SkillSourceInstallParams = {
  workspaceDir: string;
  spec: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
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

async function resolveSkillInstallSlug(params: {
  sourceDir: string;
  fallbackLabel: string;
  slug?: string;
}): Promise<string> {
  const explicit = normalizeOptionalString(params.slug);
  if (explicit) {
    return validateRequestedSkillSlug(explicit);
  }

  try {
    const raw = await fs.readFile(path.join(params.sourceDir, "SKILL.md"), "utf8");
    const frontmatterName = normalizeOptionalString(parseSkillFrontmatter(raw).name);
    if (frontmatterName) {
      return validateRequestedSkillSlug(frontmatterName);
    }
  } catch {
    // Missing/unreadable metadata and invalid display names fall back to the source label.
  }

  return validateRequestedSkillSlug(params.fallbackLabel);
}

async function rejectUndiscoverableSkillSource(params: {
  sourceDir: string;
  config?: OpenClawConfig;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  let rootRealPath: string;
  try {
    rootRealPath = await fs.realpath(params.sourceDir);
  } catch {
    return { ok: false, error: `Skill path not found: ${params.sourceDir}` };
  }
  const diagnostics: LocalSkillLoadDiagnostic[] = [];
  // Discovery owns the content rules. Install copies source bytes into a new
  // file, so a hardlinked SKILL.md does not remain a hardlink after install.
  // Rejecting that source link here would fail a skill the staged copy can load.
  const loaded = loadSingleSkillDirectory({
    skillDir: rootRealPath,
    rootRealPath,
    source: "source-install",
    maxBytes: resolveSkillDiscoveryLimits(params.config).maxSkillFileBytes,
    rejectHardlinks: false,
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });
  if (loaded) {
    return { ok: true };
  }
  const message = diagnostics[0]?.message ?? "SKILL.md is missing";
  return { ok: false, error: `Skill source is not loadable: ${message}` };
}

async function installLocalSkillDir(
  params: Omit<SkillSourceInstallParams, "spec"> & {
    sourceDir: string;
    sourceSpec: string;
    source: "path" | "git";
    fallbackLabel: string;
    git?: SkillSourceOrigin["git"];
  },
): Promise<SkillSourceInstallResult> {
  const slug = await resolveSkillInstallSlug({
    sourceDir: params.sourceDir,
    fallbackLabel: params.fallbackLabel,
    slug: params.slug,
  });
  const discoverable = await rejectUndiscoverableSkillSource({
    sourceDir: params.sourceDir,
    config: params.config,
  });
  if (!discoverable.ok) {
    return discoverable;
  }
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

async function installGitSkill(
  params: SkillSourceInstallParams,
): Promise<SkillSourceInstallResult> {
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
    try {
      await fs.cp(repoDir, exportDir, {
        recursive: true,
        filter: (source) => !path.relative(repoDir, source).split(path.sep).includes(".git"),
      });
    } catch (err) {
      return { ok: false, error: `failed to prepare git skill source: ${String(err)}` };
    }

    return await installLocalSkillDir({
      ...params,
      sourceDir: exportDir,
      sourceSpec: redactSensitiveUrlLikeString(parsed.normalizedSpec),
      source: "git",
      fallbackLabel: path.basename(parsed.label),
      git,
    });
  });
}

async function installPathSkill(
  params: SkillSourceInstallParams,
): Promise<SkillSourceInstallResult> {
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
    ...params,
    sourceDir,
    sourceSpec: params.spec,
    source: "path",
    fallbackLabel: path.basename(path.resolve(sourceDir)).trim(),
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

export async function installSkillFromSource(
  params: SkillSourceInstallParams,
): Promise<SkillSourceInstallResult> {
  const spec = params.spec.trim();
  if (spec.toLowerCase().startsWith("git:")) {
    return await installGitSkill({ ...params, spec });
  }
  return await installPathSkill({ ...params, spec });
}
