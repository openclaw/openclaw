import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveBundledInstallPlanForCatalogEntry } from "../cli/plugin-install-plan.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  findBundledPluginSourceInMap,
  resolveBundledPluginSources,
} from "../plugins/bundled-sources.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "../plugins/installs.js";
import type { PluginPackageInstall } from "../plugins/manifest.js";
import type { RuntimeEnv } from "../runtime.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { withTimeout } from "../utils/with-timeout.js";
import type { WizardPrompter } from "../wizard/prompts.js";

type InstallChoice = "npm" | "local" | "skip";
const ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS = ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS + 5_000;

export type OnboardingPluginInstallEntry = {
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
};

export type OnboardingPluginInstallStatus = "installed" | "skipped" | "failed" | "timed_out";

export type OnboardingPluginInstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId: string;
  status: OnboardingPluginInstallStatus;
};

function resolveRealDirectory(dir: string): string | null {
  try {
    const resolved = fs.realpathSync(dir);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function resolveGitRevParse(root: string, args: string[]): string | null {
  try {
    const output = execFileSync("git", ["-C", root, "rev-parse", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function resolveGitOutputDirectory(root: string, output: string | null): string | null {
  if (!output) {
    return null;
  }
  return resolveRealDirectory(path.isAbsolute(output) ? output : path.resolve(root, output));
}

function isWithinBaseDirectory(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function hasTrustedGitWorkspace(root: string): boolean {
  const realRoot = resolveRealDirectory(root);
  if (!realRoot) {
    return false;
  }
  const isInsideWorkTree = resolveGitRevParse(realRoot, ["--is-inside-work-tree"]);
  if (isInsideWorkTree !== "true") {
    return false;
  }
  const gitTopLevel = resolveGitOutputDirectory(
    realRoot,
    resolveGitRevParse(realRoot, ["--path-format=absolute", "--show-toplevel"]),
  );
  const gitCommonDir = resolveGitOutputDirectory(
    realRoot,
    resolveGitRevParse(realRoot, ["--path-format=absolute", "--git-common-dir"]),
  );
  return gitTopLevel !== null && gitCommonDir !== null;
}

function hasGitWorkspace(workspaceDir?: string): boolean {
  const roots = [process.cwd()];
  if (workspaceDir && workspaceDir !== process.cwd()) {
    roots.push(workspaceDir);
  }
  return roots.some((root) => hasTrustedGitWorkspace(root));
}

function addPluginLoadPath(cfg: OpenClawConfig, pluginPath: string): OpenClawConfig {
  const existing = cfg.plugins?.load?.paths ?? [];
  const merged = Array.from(new Set([...existing, pluginPath]));
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      load: {
        ...cfg.plugins?.load,
        paths: merged,
      },
    },
  };
}

function resolveLocalPath(params: {
  entry: OnboardingPluginInstallEntry;
  workspaceDir?: string;
  allowLocal: boolean;
}): string | null {
  if (!params.allowLocal) {
    return null;
  }
  const raw = params.entry.install.localPath?.trim();
  if (!raw) {
    return null;
  }
  const candidates = new Set<string>();
  const bases = [process.cwd()];
  if (params.workspaceDir && params.workspaceDir !== process.cwd()) {
    bases.push(params.workspaceDir);
  }
  for (const base of bases) {
    const realBase = resolveRealDirectory(base);
    if (!realBase) {
      continue;
    }
    candidates.add(path.resolve(realBase, raw));
  }
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (
        !bases.some((base) => {
          const realBase = resolveRealDirectory(base);
          return realBase ? isWithinBaseDirectory(realBase, resolved) : false;
        })
      ) {
        continue;
      }
      if (fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveBundledLocalPath(params: {
  entry: OnboardingPluginInstallEntry;
  workspaceDir?: string;
}): string | null {
  const bundledSources = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
  const npmSpec = params.entry.install.npmSpec?.trim();
  if (npmSpec) {
    return (
      resolveBundledInstallPlanForCatalogEntry({
        pluginId: params.entry.pluginId,
        npmSpec,
        findBundledSource: (lookup) =>
          findBundledPluginSourceInMap({
            bundled: bundledSources,
            lookup,
          }),
      })?.bundledSource.localPath ?? null
    );
  }
  return (
    findBundledPluginSourceInMap({
      bundled: bundledSources,
      lookup: {
        kind: "pluginId",
        value: params.entry.pluginId,
      },
    })?.localPath ?? null
  );
}

function resolveInstallDefaultChoice(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  localPath?: string | null;
  bundledLocalPath?: string | null;
  hasNpmSpec: boolean;
}): InstallChoice {
  const { cfg, entry, localPath, bundledLocalPath, hasNpmSpec } = params;
  if (!hasNpmSpec) {
    return localPath ? "local" : "skip";
  }
  if (!localPath) {
    return "npm";
  }
  if (bundledLocalPath) {
    return "local";
  }
  const updateChannel = cfg.update?.channel;
  if (updateChannel === "dev") {
    return "local";
  }
  if (updateChannel === "stable" || updateChannel === "beta") {
    return "npm";
  }
  const entryDefault = entry.install.defaultChoice;
  if (entryDefault === "local") {
    return "local";
  }
  if (entryDefault === "npm") {
    return "npm";
  }
  return "local";
}

async function promptInstallChoice(params: {
  entry: OnboardingPluginInstallEntry;
  localPath?: string | null;
  defaultChoice: InstallChoice;
  prompter: WizardPrompter;
}): Promise<InstallChoice> {
  const npmSpec = params.entry.install.npmSpec?.trim();
  const safeLabel = sanitizeTerminalText(params.entry.label);
  const safeNpmSpec = npmSpec ? sanitizeTerminalText(npmSpec) : null;
  const safeLocalPath = params.localPath ? sanitizeTerminalText(params.localPath) : null;
  const options: Array<{ value: InstallChoice; label: string; hint?: string }> = [];
  if (safeNpmSpec) {
    options.push({
      value: "npm",
      label: `Download from npm (${safeNpmSpec})`,
    });
  }
  if (params.localPath) {
    options.push({
      value: "local",
      label: "Use local plugin path",
      ...(safeLocalPath ? { hint: safeLocalPath } : {}),
    });
  }
  options.push({ value: "skip", label: "Skip for now" });

  const initialValue =
    params.defaultChoice === "local" && !params.localPath
      ? npmSpec
        ? "npm"
        : "skip"
      : params.defaultChoice;

  return await params.prompter.select<InstallChoice>({
    message: `Install ${safeLabel} plugin?`,
    options,
    initialValue,
  });
}

function formatDurationLabel(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.round(timeoutMs / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function summarizeInstallError(message: string): string {
  const cleaned = sanitizeTerminalText(message)
    .replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "")
    .trim();
  if (!cleaned) {
    return "Unknown install failure";
  }
  return cleaned.length > 180 ? `${cleaned.slice(0, 179)}…` : cleaned;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === "timeout";
}

async function installPluginFromNpmSpecWithProgress(params: {
  entry: OnboardingPluginInstallEntry;
  npmSpec: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<
  | { status: "timed_out" }
  | {
      status: "completed";
      result: Awaited<ReturnType<typeof installPluginFromNpmSpec>>;
    }
> {
  const safeLabel = sanitizeTerminalText(params.entry.label);
  const progress = params.prompter.progress(`Installing ${safeLabel} plugin…`);
  const updateProgress = (message: string) => {
    const next = sanitizeTerminalText(message).trim();
    if (!next) {
      return;
    }
    progress.update(next);
  };

  try {
    const result = await withTimeout(
      installPluginFromNpmSpec({
        spec: params.npmSpec,
        timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
        expectedIntegrity: params.entry.install.expectedIntegrity,
        logger: {
          info: updateProgress,
          warn: (message) => {
            updateProgress(message);
            params.runtime.log?.(sanitizeTerminalText(message));
          },
        },
      }),
      ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS,
    );
    if (result.ok) {
      progress.stop(`Installed ${safeLabel} plugin`);
    } else {
      progress.stop(`Install failed: ${safeLabel}`);
    }
    return {
      status: "completed",
      result,
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      progress.stop(`Install timed out: ${safeLabel}`);
      return { status: "timed_out" };
    }
    progress.stop(`Install failed: ${safeLabel}`);
    return {
      status: "completed",
      result: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function ensureOnboardingPluginInstalled(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<OnboardingPluginInstallResult> {
  const { entry, prompter, runtime, workspaceDir } = params;
  let next = params.cfg;
  const allowLocal = hasGitWorkspace(workspaceDir);
  const bundledLocalPath = resolveBundledLocalPath({ entry, workspaceDir });
  const localPath =
    bundledLocalPath ??
    resolveLocalPath({
      entry,
      workspaceDir,
      allowLocal,
    });
  const npmSpec = entry.install.npmSpec?.trim();
  const defaultChoice = resolveInstallDefaultChoice({
    cfg: next,
    entry,
    localPath,
    bundledLocalPath,
    hasNpmSpec: Boolean(npmSpec),
  });
  const choice = await promptInstallChoice({
    entry,
    localPath,
    defaultChoice,
    prompter,
  });

  if (choice === "skip") {
    return {
      cfg: next,
      installed: false,
      pluginId: entry.pluginId,
      status: "skipped",
    };
  }

  if (choice === "local" && localPath) {
    next = addPluginLoadPath(next, localPath);
    next = enablePluginInConfig(next, entry.pluginId).config;
    return {
      cfg: next,
      installed: true,
      pluginId: entry.pluginId,
      status: "installed",
    };
  }

  if (!npmSpec) {
    await prompter.note(
      `No npm install source is available for ${sanitizeTerminalText(entry.label)}. Returning to selection.`,
      "Plugin install",
    );
    runtime.error?.(
      `Plugin install failed: no npm spec available for ${sanitizeTerminalText(entry.pluginId)}.`,
    );
    return {
      cfg: next,
      installed: false,
      pluginId: entry.pluginId,
      status: "failed",
    };
  }

  const installOutcome = await installPluginFromNpmSpecWithProgress({
    entry,
    npmSpec,
    prompter,
    runtime,
  });

  if (installOutcome.status === "timed_out") {
    await prompter.note(
      [
        `Installing ${sanitizeTerminalText(npmSpec)} timed out after ${formatDurationLabel(ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS)}.`,
        "Returning to selection.",
      ].join("\n"),
      "Plugin install",
    );
    runtime.error?.(
      `Plugin install timed out after ${ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS}ms: ${sanitizeTerminalText(npmSpec)}`,
    );
    return {
      cfg: next,
      installed: false,
      pluginId: entry.pluginId,
      status: "timed_out",
    };
  }

  const { result } = installOutcome;

  if (result.ok) {
    next = enablePluginInConfig(next, result.pluginId).config;
    next = recordPluginInstall(next, {
      pluginId: result.pluginId,
      source: "npm",
      spec: npmSpec,
      installPath: result.targetDir,
      version: result.version,
      ...buildNpmResolutionInstallFields(result.npmResolution),
    });
    return {
      cfg: next,
      installed: true,
      pluginId: result.pluginId,
      status: "installed",
    };
  }

  await prompter.note(
    [
      `Failed to install ${sanitizeTerminalText(npmSpec)}: ${summarizeInstallError(result.error)}`,
      "Returning to selection.",
    ].join("\n"),
    "Plugin install",
  );

  if (localPath) {
    const fallback = await prompter.confirm({
      message: `Use local plugin path instead? (${sanitizeTerminalText(localPath)})`,
      initialValue: true,
    });
    if (fallback) {
      next = addPluginLoadPath(next, localPath);
      next = enablePluginInConfig(next, entry.pluginId).config;
      return {
        cfg: next,
        installed: true,
        pluginId: entry.pluginId,
        status: "installed",
      };
    }
  }

  runtime.error?.(`Plugin install failed: ${sanitizeTerminalText(result.error)}`);
  return {
    cfg: next,
    installed: false,
    pluginId: entry.pluginId,
    status: "failed",
  };
}
