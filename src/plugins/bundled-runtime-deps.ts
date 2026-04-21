import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizePluginsConfig } from "./config-state.js";

export type RuntimeDepEntry = {
  name: string;
  version: string;
  pluginIds: string[];
};

export type RuntimeDepConflict = {
  name: string;
  versions: string[];
  pluginIdsByVersion: Map<string, string[]>;
};

export type BundledRuntimeDepsInstallParams = {
  installRoot: string;
  missingSpecs: string[];
  installSpecs?: string[];
};

type JsonObject = Record<string, unknown>;

export type BundledRuntimeDepsNpmRunner = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

function dependencySentinelPath(depName: string): string {
  return path.join("node_modules", ...depName.split("/"), "package.json");
}

function readJsonObject(filePath: string): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function collectRuntimeDeps(packageJson: JsonObject): Record<string, unknown> {
  return {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.optionalDependencies as Record<string, unknown> | undefined),
  };
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

function isSourceCheckoutBundledPluginRoot(pluginRoot: string): boolean {
  const extensionsDir = path.dirname(pluginRoot);
  if (path.basename(extensionsDir) !== "extensions") {
    return false;
  }
  return isSourceCheckoutRoot(path.dirname(extensionsDir));
}

function createNestedNpmInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_location;
  delete nextEnv.npm_config_prefix;
  return nextEnv;
}

function resolvePathEnvKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

export function resolveBundledRuntimeDepsNpmRunner(params: {
  npmArgs: string[];
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: typeof fs.existsSync;
  platform?: NodeJS.Platform;
}): BundledRuntimeDepsNpmRunner {
  const env = params.env ?? process.env;
  const execPath = params.execPath ?? process.execPath;
  const existsSync = params.existsSync ?? fs.existsSync;
  const platform = params.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(execPath);

  const npmCliCandidates = [
    pathImpl.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    pathImpl.resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCliPath = npmCliCandidates.find((candidate) => existsSync(candidate));
  if (npmCliPath) {
    return {
      command: execPath,
      args: [npmCliPath, ...params.npmArgs],
    };
  }

  if (platform === "win32") {
    const npmExePath = pathImpl.resolve(nodeDir, "npm.exe");
    if (existsSync(npmExePath)) {
      return {
        command: npmExePath,
        args: params.npmArgs,
      };
    }
    throw new Error(
      `failed to resolve a toolchain-local npm next to ${execPath}. ` +
        `Checked: ${[...npmCliCandidates, npmExePath].join(", ")}.`,
    );
  }

  const pathKey = resolvePathEnvKey(env, platform);
  const currentPath = env[pathKey];
  return {
    command: "npm",
    args: params.npmArgs,
    env: {
      ...env,
      [pathKey]:
        typeof currentPath === "string" && currentPath.length > 0
          ? `${nodeDir}${path.delimiter}${currentPath}`
          : nodeDir,
    },
  };
}

function readBundledPluginChannels(pluginDir: string): string[] {
  const manifest = readJsonObject(path.join(pluginDir, "openclaw.plugin.json"));
  const channels = manifest?.channels;
  if (!Array.isArray(channels)) {
    return [];
  }
  return channels.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function readBundledPluginEnabledByDefault(pluginDir: string): boolean {
  return readJsonObject(path.join(pluginDir, "openclaw.plugin.json"))?.enabledByDefault === true;
}

function isBundledPluginConfiguredForRuntimeDeps(params: {
  config: OpenClawConfig;
  pluginId: string;
  pluginDir: string;
}): boolean {
  const plugins = normalizePluginsConfig(params.config.plugins);
  if (!plugins.enabled) {
    return false;
  }
  if (plugins.deny.includes(params.pluginId)) {
    return false;
  }
  const entry = plugins.entries[params.pluginId];
  if (entry?.enabled === false) {
    return false;
  }
  if (entry?.enabled === true) {
    return true;
  }
  for (const channelId of readBundledPluginChannels(params.pluginDir)) {
    const normalizedChannelId = normalizeChatChannelId(channelId);
    if (!normalizedChannelId) {
      continue;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === true
    ) {
      return true;
    }
  }
  return readBundledPluginEnabledByDefault(params.pluginDir);
}

function shouldIncludeBundledPluginRuntimeDeps(params: {
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  pluginId: string;
  pluginDir: string;
}): boolean {
  if (params.pluginIds && !params.pluginIds.has(params.pluginId)) {
    return false;
  }
  if (!params.config) {
    return true;
  }
  return isBundledPluginConfiguredForRuntimeDeps({
    config: params.config,
    pluginId: params.pluginId,
    pluginDir: params.pluginDir,
  });
}

function collectBundledPluginRuntimeDeps(params: {
  extensionsDir: string;
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
}): {
  deps: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  const versionMap = new Map<string, Map<string, Set<string>>>();

  for (const entry of fs.readdirSync(params.extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const pluginDir = path.join(params.extensionsDir, pluginId);
    if (
      !shouldIncludeBundledPluginRuntimeDeps({
        config: params.config,
        pluginIds: params.pluginIds,
        pluginId,
        pluginDir,
      })
    ) {
      continue;
    }
    const packageJson = readJsonObject(path.join(pluginDir, "package.json"));
    if (!packageJson) {
      continue;
    }
    for (const [name, rawVersion] of Object.entries(collectRuntimeDeps(packageJson))) {
      if (typeof rawVersion !== "string" || rawVersion.trim() === "") {
        continue;
      }
      const version = rawVersion.trim();
      const byVersion = versionMap.get(name) ?? new Map<string, Set<string>>();
      const pluginIds = byVersion.get(version) ?? new Set<string>();
      pluginIds.add(pluginId);
      byVersion.set(version, pluginIds);
      versionMap.set(name, byVersion);
    }
  }

  const deps: RuntimeDepEntry[] = [];
  const conflicts: RuntimeDepConflict[] = [];
  for (const [name, byVersion] of versionMap.entries()) {
    if (byVersion.size === 1) {
      const [version, pluginIds] = [...byVersion.entries()][0] ?? [];
      if (version) {
        deps.push({
          name,
          version,
          pluginIds: [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
        });
      }
      continue;
    }
    const versions = [...byVersion.keys()].toSorted((a, b) => a.localeCompare(b));
    const pluginIdsByVersion = new Map<string, string[]>();
    for (const [version, pluginIds] of byVersion.entries()) {
      pluginIdsByVersion.set(
        version,
        [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
      );
    }
    conflicts.push({
      name,
      versions,
      pluginIdsByVersion,
    });
  }

  return {
    deps: deps.toSorted((a, b) => a.name.localeCompare(b.name)),
    conflicts: conflicts.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

function normalizePluginIdSet(
  pluginIds: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!pluginIds) {
    return undefined;
  }
  const normalized = pluginIds
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return new Set(normalized);
}

export function scanBundledPluginRuntimeDeps(params: {
  packageRoot: string;
  config?: OpenClawConfig;
  pluginIds?: readonly string[];
}): {
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  if (isSourceCheckoutRoot(params.packageRoot)) {
    return { missing: [], conflicts: [] };
  }
  const extensionsDir = path.join(params.packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return { missing: [], conflicts: [] };
  }
  const { deps, conflicts } = collectBundledPluginRuntimeDeps({
    extensionsDir,
    config: params.config,
    pluginIds: normalizePluginIdSet(params.pluginIds),
  });
  const missing = deps.filter(
    (dep) =>
      !fs.existsSync(path.join(params.packageRoot, dependencySentinelPath(dep.name))) &&
      !fs.existsSync(path.join(extensionsDir, dependencySentinelPath(dep.name))) &&
      dep.pluginIds.every(
        (pluginId) =>
          !fs.existsSync(path.join(extensionsDir, pluginId, dependencySentinelPath(dep.name))),
      ),
  );
  return { missing, conflicts };
}

export function resolveBundledRuntimeDependencyInstallRoot(pluginRoot: string): string {
  const extensionsDir = path.dirname(pluginRoot);
  const buildDir = path.dirname(extensionsDir);
  if (
    path.basename(extensionsDir) === "extensions" &&
    (path.basename(buildDir) === "dist" || path.basename(buildDir) === "dist-runtime")
  ) {
    return extensionsDir;
  }
  return extensionsDir;
}

export function installBundledRuntimeDeps(params: {
  installRoot: string;
  missingSpecs: string[];
  env: NodeJS.ProcessEnv;
}): void {
  const npmRunner = resolveBundledRuntimeDepsNpmRunner({
    env: params.env,
    npmArgs: [
      "install",
      "--prefix",
      params.installRoot,
      "--omit=dev",
      "--no-save",
      "--package-lock=false",
      "--ignore-scripts",
      "--legacy-peer-deps",
      ...params.missingSpecs,
    ],
  });
  const result = spawnSync(npmRunner.command, npmRunner.args, {
    cwd: params.installRoot,
    encoding: "utf8",
    env: createNestedNpmInstallEnv(npmRunner.env ?? params.env),
    stdio: "pipe",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(output || "npm install failed");
  }
}

export function ensureBundledPluginRuntimeDeps(params: {
  pluginId: string;
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  retainSpecs?: readonly string[];
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
}): string[] {
  if (isSourceCheckoutBundledPluginRoot(params.pluginRoot)) {
    return [];
  }
  if (
    params.config &&
    !isBundledPluginConfiguredForRuntimeDeps({
      config: params.config,
      pluginId: params.pluginId,
      pluginDir: params.pluginRoot,
    })
  ) {
    return [];
  }
  const packageJson = readJsonObject(path.join(params.pluginRoot, "package.json"));
  if (!packageJson) {
    return [];
  }
  const deps = Object.entries(collectRuntimeDeps(packageJson))
    .map(([name, rawVersion]) =>
      typeof rawVersion === "string" && rawVersion.trim() !== ""
        ? { name, version: rawVersion.trim() }
        : null,
    )
    .filter((entry): entry is { name: string; version: string } => Boolean(entry));
  if (deps.length === 0) {
    return [];
  }

  const installRoot = resolveBundledRuntimeDependencyInstallRoot(params.pluginRoot);
  const dependencySpecs = deps
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
  const missingSpecs = deps
    .filter((dep) => !fs.existsSync(path.join(installRoot, dependencySentinelPath(dep.name))))
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
  if (missingSpecs.length === 0) {
    return [];
  }
  const installSpecs = [...new Set([...(params.retainSpecs ?? []), ...dependencySpecs])].toSorted(
    (left, right) => left.localeCompare(right),
  );

  const install =
    params.installDeps ??
    ((installParams) =>
      installBundledRuntimeDeps({
        installRoot: installParams.installRoot,
        missingSpecs: installParams.installSpecs ?? installParams.missingSpecs,
        env: params.env,
      }));
  install({ installRoot, missingSpecs, installSpecs });
  return installSpecs;
}
