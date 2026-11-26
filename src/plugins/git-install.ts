import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { pathExists } from "../infra/fs-safe.js";
import { acquireGitSource } from "../infra/git-source.js";
import {
  resolveInstallWorkTimeoutMs,
  resolveTimedInstallModeOptions,
} from "../infra/install-mode-options.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { withInstallWorkspace } from "../infra/install-source-utils.js";
import { resolveNpmCommand } from "../infra/npm-command.js";
import {
  createSafeNpmInstallArgs,
  createSafeNpmInstallEnv,
} from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { isImmutableGitCommitRef, parseGitPluginSpec } from "./git-source-spec.js";
import { resolveDefaultPluginGitDir } from "./install-paths.js";
import {
  preflightPluginGitInstallPolicy,
  type InstallSafetyOverrides,
} from "./install-security-scan.js";
import {
  ensureInstallTargetAvailableForMode,
  loadPluginInstallRuntime,
  reportBlockedPluginInstall,
} from "./install-shared.js";
import {
  attachPluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
} from "./install-transaction.js";
import type { PluginInstallArtifactConsentHandler, PluginInstallLogger } from "./install-types.js";
import { installPluginFromInstalledPackageDir, type InstallPluginResult } from "./install.js";
import { emitPluginInstallSecurityEvent } from "./security-events.js";

const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** Resolved Git source metadata persisted into plugin install records. */
type GitPluginResolution = {
  url: string;
  ref?: string;
  commit?: string;
  resolvedAt: string;
};

type GitPluginInstallResult =
  | (Extract<InstallPluginResult, { ok: true }> & { git: GitPluginResolution })
  | Extract<InstallPluginResult, { ok: false }>;

function createGitCommandEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: "",
    GIT_EDITOR: "",
    GIT_SEQUENCE_EDITOR: "",
    GIT_EXTERNAL_DIFF: "",
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_EXEC_PATH: undefined,
    GIT_SSL_NO_VERIFY: undefined,
  };
}

export async function installPluginFromGitSpec(
  params: InstallSafetyOverrides & {
    spec: string;
    extensionsDir?: string;
    gitDir?: string;
    timeoutMs?: number;
    workTimeoutMs?: number | null;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
    beforePersistentApply?: () => void;
  },
): Promise<GitPluginInstallResult> {
  const parsed = parseGitPluginSpec(params.spec);
  if (!parsed) {
    return {
      ok: false,
      error: `unsupported git: plugin spec: ${params.spec}`,
    };
  }

  const { workTimeoutMs } = resolveTimedInstallModeOptions(params, {});
  const gitRoot = params.gitDir ? resolveUserPath(params.gitDir) : resolveDefaultPluginGitDir();
  const redactedSpec = redactSensitiveUrlLikeString(parsed.normalizedSpec);
  const persistentRepoDir = path.join(
    gitRoot,
    `git-${sha256HexPrefixCore(redactedSpec, 16)}`,
    "repo",
  );
  const effectiveMode =
    params.mode === "update" && (await pathExists(persistentRepoDir)) ? "update" : "install";
  const availability = await ensureInstallTargetAvailableForMode({
    runtime: await loadPluginInstallRuntime(),
    targetPath: persistentRepoDir,
    mode: effectiveMode,
  });
  if (!availability.ok) {
    return availability;
  }
  const prepare = async (repoDir: string): Promise<GitPluginInstallResult> => {
    params.logger?.info?.(
      `Cloning ${sanitizeForLog(redactSensitiveUrlLikeString(parsed.label))}...`,
    );
    const acquired = await acquireGitSource({
      ...parsed,
      repoDir,
      refMode: "resolve-remote",
      timeoutMs: params.timeoutMs,
      workTimeoutMs,
      commandEnv: () => ({ env: createGitCommandEnv() }),
      cloneNoHardlinks: !params.dryRun,
    });
    if (!acquired.ok) {
      return acquired;
    }

    const installPolicyRequest = {
      kind: "plugin-git" as const,
      requestedSpecifier: parsed.input,
      source: {
        kind: "git" as const,
        authority: "third-party" as const,
        mutable: !isImmutableGitCommitRef(parsed.ref),
        network: true,
      },
    };
    const preflight = await preflightPluginGitInstallPolicy({
      config: params.config,
      onInstallPolicyWarning: params.onInstallPolicyWarning,
      logger: params.logger ?? {},
      mode: effectiveMode,
      pluginId: params.expectedPluginId ?? parsed.label,
      requestedSpecifier: parsed.input,
      source: installPolicyRequest.source,
      sourcePath: repoDir,
    });
    if (preflight?.blocked) {
      return reportBlockedPluginInstall({
        blocked: { reason: preflight.blocked.reason, code: preflight.blocked.code },
        pluginId: params.expectedPluginId,
        mode: effectiveMode,
        sourceFamily: "git",
      });
    }

    if (!params.dryRun) {
      params.logger?.info?.("Installing plugin dependencies with npm…");
      const install = await runCommandWithTimeout(
        resolveNpmCommand(
          createSafeNpmInstallArgs({
            noAudit: true,
            noFund: true,
          }),
        ),
        {
          cwd: repoDir,
          timeoutMs: resolveInstallWorkTimeoutMs(
            workTimeoutMs,
            Math.max(params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, 300_000),
          ),
          env: createSafeNpmInstallEnv(process.env, {
            npmConfigCwd: repoDir,
            packageLock: true,
            quiet: true,
          }),
        },
      );
      if (install.code !== 0) {
        return {
          ok: false,
          error: `npm install failed: ${install.stderr.trim() || install.stdout.trim()}`,
        };
      }
    }

    const result = await installPluginFromInstalledPackageDir({
      onInstallPolicyWarning: params.onInstallPolicyWarning,
      config: params.config,
      packageDir: repoDir,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
      logger: params.logger,
      mode: effectiveMode,
      installPolicyRequest,
    });
    if (!result.ok) {
      return result;
    }
    if (!params.dryRun) {
      await params.onBeforePluginArtifactCommit?.({
        pluginId: result.pluginId,
        ...(effectiveMode === "update" ? { currentArtifactDir: persistentRepoDir } : {}),
        stagedArtifactDir: repoDir,
        mode: effectiveMode,
      });
    }
    return {
      ...result,
      git: {
        url: parsed.url,
        ref: parsed.ref,
        commit: acquired.commit,
        resolvedAt: new Date().toISOString(),
      },
    };
  };
  if (params.dryRun) {
    return await withInstallWorkspace("openclaw-git-plugin-", (tmpDir) =>
      prepare(path.join(tmpDir, "repo")),
    );
  }

  try {
    await fs.mkdir(path.dirname(persistentRepoDir), { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      error: `failed to replace managed git plugin repository: ${String(error)}`,
    };
  }
  let preparation: Promise<GitPluginInstallResult> | undefined;
  const transactionRequest = resolvePluginInstallTransactionRequest(params);
  const installParams: Parameters<typeof installPackageDir>[0] = {
    targetDir: persistentRepoDir,
    mode: effectiveMode,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    copyErrorPrefix: "failed to replace managed git plugin repository",
    hasDeps: false,
    depsLogMessage: "",
    beforePersistentApply: params.beforePersistentApply,
    afterInstall: (stageDir: string) => (preparation = prepare(stageDir)),
  };
  const published = await installPackageDir(
    transactionRequest
      ? requestDeferredPackageDirInstall(
          installParams,
          transactionRequest.assertOwned,
          transactionRequest.prepareSettlement,
        )
      : installParams,
  ).catch((error: unknown) => ({
    ok: false as const,
    error: `failed to replace managed git plugin repository: ${String(error)}`,
  }));
  // The directory owner settles its stage before the preparation's original error escapes.
  const result = preparation ? await preparation : undefined;
  if (!published.ok) {
    return published;
  }
  if (!result?.ok) {
    throw new Error("Git repository published without a validated plugin");
  }

  const installed = { ...result, targetDir: persistentRepoDir };
  emitPluginInstallSecurityEvent({
    pluginId: installed.pluginId,
    mode: effectiveMode,
    sourceFamily: "git",
    extensionCount: installed.extensions.length,
    hasVersion: Boolean(installed.version),
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
  });
  const transaction = resolvePackageDirInstallTransaction(published);
  return transaction ? attachPluginInstallTransaction(installed, transaction) : installed;
}
