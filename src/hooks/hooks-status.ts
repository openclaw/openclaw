import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { HookEligibilityContext, HookEntry, HookInstallSpec } from "./types.js";
import { evaluateRequirements } from "../shared/requirements.js";
import { CONFIG_DIR } from "../utils.js";
import { hasBinary, isConfigPathTruthy, resolveConfigPath, resolveHookConfig } from "./config.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

export type HookStatusConfigCheck = {
  path: string;
  value: unknown;
  satisfied: boolean;
};

export type HookInstallOption = {
  id: string;
  kind: HookInstallSpec["kind"];
  label: string;
  bins: string[];
};

export type HookStatusEntry = {
  name: string;
  description: string;
  source: string;
  pluginId?: string;
  filePath: string;
  baseDir: string;
  handlerPath: string;
  hookKey: string;
  emoji?: string;
  homepage?: string;
  events: string[];
  always: boolean;
  disabled: boolean;
  eligible: boolean;
  managedByPlugin: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: HookStatusConfigCheck[];
  install: HookInstallOption[];
};

export type HookStatusReport = {
  workspaceDir: string;
  managedHooksDir: string;
  hooks: HookStatusEntry[];
};

function resolveHookKey(entry: HookEntry): string {
  return entry.metadata?.hookKey ?? entry.hook.name;
}

function normalizeInstallOptions(entry: HookEntry): HookInstallOption[] {
  const install = entry.metadata?.install ?? [];
  if (install.length === 0) {
    return [];
  }

  // For hooks, we just list all install options
  return install.map((spec, index) => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();

    if (!label) {
      if (spec.kind === "bundled") {
        label = "Bundled with OpenClaw";
      } else if (spec.kind === "npm" && spec.package) {
        label = `Install ${spec.package} (npm)`;
      } else if (spec.kind === "git" && spec.repository) {
        label = `Install from ${spec.repository}`;
      } else {
        label = "Run installer";
      }
    }

    return { id, kind: spec.kind, label, bins };
  });
}

function buildHookStatus(
  entry: HookEntry,
  config?: OpenClawConfig,
  eligibility?: HookEligibilityContext,
): HookStatusEntry {
  const hookKey = resolveHookKey(entry);
  const hookConfig = resolveHookConfig(config, hookKey);
  const managedByPlugin = entry.hook.source === "openclaw-plugin";
  const disabled = managedByPlugin ? false : hookConfig?.enabled === false;
  const always = entry.metadata?.always === true;
  const emoji = entry.metadata?.emoji ?? entry.frontmatter.emoji;
  const homepageRaw =
    entry.metadata?.homepage ??
    entry.frontmatter.homepage ??
    entry.frontmatter.website ??
    entry.frontmatter.url;
  const homepage = homepageRaw?.trim() ? homepageRaw.trim() : undefined;
  const events = entry.metadata?.events ?? [];

  const requiredBins = entry.metadata?.requires?.bins ?? [];
  const requiredAnyBins = entry.metadata?.requires?.anyBins ?? [];
  const requiredEnv = entry.metadata?.requires?.env ?? [];
  const requiredConfig = entry.metadata?.requires?.config ?? [];
  const requiredOs = entry.metadata?.os ?? [];

  const {
    missing,
    eligible: requirementsSatisfied,
    configChecks,
  } = evaluateRequirements({
    always,
    required: {
      bins: requiredBins,
      anyBins: requiredAnyBins,
      env: requiredEnv,
      config: requiredConfig,
      os: requiredOs,
    },
    hasLocalBin: hasBinary,
    hasRemoteBin: eligibility?.remote?.hasBin,
    hasRemoteAnyBin: eligibility?.remote?.hasAnyBin,
    localPlatform: process.platform,
    remotePlatforms: eligibility?.remote?.platforms,
    isEnvSatisfied: (envName) => Boolean(process.env[envName] || hookConfig?.env?.[envName]),
    resolveConfigValue: (pathStr) => resolveConfigPath(config, pathStr),
    isConfigSatisfied: (pathStr) => isConfigPathTruthy(config, pathStr),
  });

  const eligible = !disabled && requirementsSatisfied;

  return {
    name: entry.hook.name,
    description: entry.hook.description,
    source: entry.hook.source,
    pluginId: entry.hook.pluginId,
    filePath: entry.hook.filePath,
    baseDir: entry.hook.baseDir,
    handlerPath: entry.hook.handlerPath,
    hookKey,
    emoji,
    homepage,
    events,
    always,
    disabled,
    eligible,
    managedByPlugin,
    requirements: {
      bins: requiredBins,
      anyBins: requiredAnyBins,
      env: requiredEnv,
      config: requiredConfig,
      os: requiredOs,
    },
    missing,
    configChecks,
    install: normalizeInstallOptions(entry),
  };
}

export function buildWorkspaceHookStatus(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedHooksDir?: string;
    entries?: HookEntry[];
    eligibility?: HookEligibilityContext;
  },
): HookStatusReport {
  const managedHooksDir = opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks");
  const hookEntries = opts?.entries ?? loadWorkspaceHookEntries(workspaceDir, opts);

  return {
    workspaceDir,
    managedHooksDir,
    hooks: hookEntries.map((entry) => buildHookStatus(entry, opts?.config, opts?.eligibility)),
  };
}
