import fs from "node:fs";
import path from "node:path";
import { resolveBundledInstallPlanForCatalogEntry } from "../cli/plugin-install-plan.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGitHeadPath } from "../infra/git-root.js";
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
import type { WizardPrompter } from "../wizard/prompts.js";

type InstallChoice = "npm" | "local" | "skip";

export type OnboardingPluginInstallEntry = {
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
};

export type OnboardingPluginInstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId: string;
};

function hasGitHead(gitDir: string): boolean {
  return fs.existsSync(path.join(gitDir, "HEAD"));
}

function hasGitObjectStore(gitDir: string): boolean {
  return fs.existsSync(path.join(gitDir, "objects")) && fs.existsSync(path.join(gitDir, "refs"));
}

function looksLikeGitDir(gitDir: string): boolean {
  return hasGitHead(gitDir) && hasGitObjectStore(gitDir);
}

function resolveGitCommonDir(gitDir: string): string | null {
  const commondirPath = path.join(gitDir, "commondir");
  try {
    const raw = fs.readFileSync(commondirPath, "utf8").trim();
    if (!raw) {
      return null;
    }
    return path.resolve(gitDir, raw);
  } catch {
    return null;
  }
}

function hasGitWorkspace(workspaceDir?: string): boolean {
  const roots = [process.cwd()];
  if (workspaceDir && workspaceDir !== process.cwd()) {
    roots.push(workspaceDir);
  }
  for (const root of roots) {
    const headPath = resolveGitHeadPath(root);
    if (!headPath) {
      continue;
    }
    const gitDir = path.dirname(headPath);
    if (looksLikeGitDir(gitDir)) {
      return true;
    }
    const commonDir = resolveGitCommonDir(gitDir);
    if (commonDir && hasGitHead(gitDir) && hasGitObjectStore(commonDir)) {
      return true;
    }
  }
  return false;
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
  candidates.add(path.resolve(process.cwd(), raw));
  if (params.workspaceDir && params.workspaceDir !== process.cwd()) {
    candidates.add(path.resolve(params.workspaceDir, raw));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
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
    };
  }

  if (choice === "local" && localPath) {
    next = addPluginLoadPath(next, localPath);
    next = enablePluginInConfig(next, entry.pluginId).config;
    return {
      cfg: next,
      installed: true,
      pluginId: entry.pluginId,
    };
  }

  if (!npmSpec) {
    runtime.error?.(
      `Plugin install failed: no npm spec available for ${sanitizeTerminalText(entry.pluginId)}.`,
    );
    return {
      cfg: next,
      installed: false,
      pluginId: entry.pluginId,
    };
  }

  const result = await installPluginFromNpmSpec({
    spec: npmSpec,
    expectedIntegrity: entry.install.expectedIntegrity,
    logger: {
      info: (message) => runtime.log?.(message),
      warn: (message) => runtime.log?.(message),
    },
  });

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
    };
  }

  await prompter.note(
    `Failed to install ${sanitizeTerminalText(npmSpec)}: ${sanitizeTerminalText(result.error)}`,
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
      };
    }
  }

  runtime.error?.(`Plugin install failed: ${sanitizeTerminalText(result.error)}`);
  return {
    cfg: next,
    installed: false,
    pluginId: entry.pluginId,
  };
}
