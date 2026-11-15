import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireGitSource } from "../../infra/git-source.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { withInstallWorkspace } from "../../infra/install-source-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isImmutableGitCommitRef, parseGitPluginSpec } from "../../plugins/git-install.js";
import type { InstallSafetyOverrides } from "../../plugins/install-security-scan.types.js";
import { resolveUserPath } from "../../utils.js";
import {
  loadSingleSkillDirectory,
  type LocalSkillLoadDiagnostic,
} from "../loading/local-loader.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import { installExtractedSkillRoot } from "./archive-install.js";
import { validateRequestedSkillSlug } from "./install-paths.js";
import { recordSkillSourceInstall, type SkillSourceOrigin } from "./source-install-metadata.js";

const log = createSubsystemLogger("skills");

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

type InstalledSkillSource = {
  slug: string;
  targetDir: string;
  source: "path" | "git";
  git?: SkillSourceOrigin["git"];
};

async function installLocalSkillDir(
  params: Omit<SkillSourceInstallParams, "spec"> & {
    sourceDir: string;
    sourceSpec: string;
    source: "path" | "git";
    fallbackLabel: string;
    git?: SkillSourceOrigin["git"];
  },
): Promise<InstalledSkillSource> {
  const slug = await (async (): Promise<string> => {
    const { sourceDir, fallbackLabel, slug: slugInput, config } = params;
    const explicit = normalizeOptionalString(slugInput);
    const requestedSlug = explicit ? validateRequestedSkillSlug(explicit) : undefined;
    let rootRealPath: string;
    try {
      rootRealPath = await fs.realpath(sourceDir);
    } catch (error) {
      throw new Error(`Skill path not found: ${sourceDir}`, { cause: error });
    }
    const diagnostics: LocalSkillLoadDiagnostic[] = [];
    // Discovery owns the content rules. Install copies source bytes into a new
    // file, so a hardlinked SKILL.md does not remain a hardlink after install.
    // Rejecting that source link here would fail a skill the staged copy can load.
    const loaded = loadSingleSkillDirectory({
      skillDir: rootRealPath,
      rootRealPath,
      source: "source-install",
      maxBytes: resolveSkillDiscoveryLimits(config).maxSkillFileBytes,
      rejectHardlinks: false,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    if (!loaded) {
      const message = diagnostics[0]?.message ?? "SKILL.md is missing";
      throw new Error(`Skill source is not loadable: ${message}`);
    }
    if (requestedSlug) {
      return requestedSlug;
    }
    const frontmatterName = normalizeOptionalString(loaded.frontmatter.name);
    if (frontmatterName) {
      try {
        return validateRequestedSkillSlug(frontmatterName);
      } catch {
        // Invalid display names use the source label instead.
      }
    }
    return validateRequestedSkillSlug(fallbackLabel);
  })();
  const workspaceAccess = getAgentWorkspaceAccess(params.workspaceDir, "loadSkills");
  const access = workspaceAccess?.loadSkills ? workspaceAccess : undefined;
  if (access && !access.recordSkillSourceInstall) {
    throw new Error("Remote workspace skill source tracking is unavailable");
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
    throw new Error(install.error);
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
  try {
    const { refreshSkillsDiscovery } = await import("../runtime/refresh.js");
    await refreshSkillsDiscovery({ workspaceDir: params.workspaceDir, config: params.config });
  } catch (error) {
    log.warn(`Skill source saved, but discovery refresh failed: ${formatErrorMessage(error)}`);
  }

  return {
    slug,
    targetDir: install.targetDir,
    source: params.source,
    ...(params.git ? { git: params.git } : {}),
  };
}

async function installGitSkill(params: SkillSourceInstallParams): Promise<InstalledSkillSource> {
  const parsed = parseGitPluginSpec(params.spec);
  if (!parsed) {
    throw new Error(`Unsupported git skill spec: ${params.spec}`);
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
      commandEnv: () => ({
        baseEnv: {},
        env: sanitizeHostExecEnv({
          baseEnv: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
          blockPathOverrides: false,
        }),
      }),
    });
    if (!acquired.ok) {
      throw new Error(acquired.error);
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
      throw new Error(`failed to prepare git skill source: ${String(err)}`, { cause: err });
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
): Promise<InstalledSkillSource> {
  const spec = params.spec.trim();
  if (spec.toLowerCase().startsWith("git:")) {
    return await installGitSkill({ ...params, spec });
  }
  const sourceDir = resolveUserPath(spec);
  let stat;
  try {
    stat = await fs.stat(sourceDir);
  } catch (error) {
    throw new Error(`Skill path not found: ${sourceDir}`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`Skill path is not a directory: ${sourceDir}`);
  }
  return await installLocalSkillDir({
    ...params,
    sourceDir,
    sourceSpec: spec,
    source: "path",
    fallbackLabel: path.basename(path.resolve(sourceDir)).trim(),
  });
}
