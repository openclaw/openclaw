import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { maintainConfigBackups } from "../config/backup-rotation.js";
import {
  clearConfigCache,
  parseConfigJson5,
  readConfigFileSnapshotForWrite,
  validateConfigObjectRawWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import { restoreEnvVarRefs } from "../config/env-preserve.js";
import { INCLUDE_KEY } from "../config/includes.js";
import type { OpenClawConfig } from "../config/types.js";
import { writeTextAtomic } from "../infra/json-files.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolvePluginsIncludePath(configPath: string, parsedRoot: unknown): string | null {
  if (!isPlainRecord(parsedRoot) || !("plugins" in parsedRoot)) {
    return null;
  }
  const pluginsNode = parsedRoot.plugins;
  if (!isPlainRecord(pluginsNode) || Object.keys(pluginsNode).length !== 1) {
    return null;
  }
  const includePath = pluginsNode[INCLUDE_KEY];
  if (typeof includePath !== "string" || includePath.length === 0) {
    return null;
  }
  return path.isAbsolute(includePath)
    ? includePath
    : path.resolve(path.dirname(configPath), includePath);
}

function resolveChangedRootKeys(current: OpenClawConfig, next: OpenClawConfig): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (key === "plugins") {
      continue;
    }
    if (
      !isDeepStrictEqual(current[key as keyof OpenClawConfig], next[key as keyof OpenClawConfig])
    ) {
      changed.push(key);
    }
  }
  return changed;
}

function validateConfigForPluginWrite(nextConfig: OpenClawConfig): OpenClawConfig {
  const validated = validateConfigObjectRawWithPlugins(nextConfig);
  if (validated.ok) {
    return validated.config;
  }
  const issue = validated.issues[0];
  const pathLabel = issue?.path ? issue.path : "<root>";
  const issueMessage = issue?.message ?? "invalid";
  throw new Error(`Config validation failed: ${pathLabel}: ${issueMessage}`);
}

async function ensureIncludedPluginsFileIsReadable(filePath: string): Promise<void> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok || !isPlainRecord(parsed.parsed)) {
    throw new Error(`Invalid plugins include file: ${filePath}`);
  }
}

async function restoreConfigFragmentEnvRefs(
  filePath: string,
  value: unknown,
  envSnapshot?: Record<string, string | undefined>,
): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok) {
    return value;
  }
  return restoreEnvVarRefs(value, parsed.parsed, envSnapshot ?? process.env);
}

async function writePluginsIncludeFile(
  filePath: string,
  plugins: OpenClawConfig["plugins"] | undefined,
  envSnapshot?: Record<string, string | undefined>,
): Promise<void> {
  const nextValue = await restoreConfigFragmentEnvRefs(filePath, plugins ?? {}, envSnapshot);
  await writeConfigFragment(filePath, nextValue);
}

function buildUpdatedRootSource(
  parsedRoot: unknown,
  nextConfig: OpenClawConfig,
  changedKeys: string[],
): Record<string, unknown> | null {
  if (!isPlainRecord(parsedRoot)) {
    return null;
  }
  const nextRoot = structuredClone(parsedRoot);
  for (const key of changedKeys) {
    const nextValue = nextConfig[key as keyof OpenClawConfig];
    if (nextValue === undefined) {
      delete nextRoot[key];
      continue;
    }
    nextRoot[key] = structuredClone(nextValue);
  }
  return nextRoot;
}

async function writeConfigFragment(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.access(filePath).then(
    async () => await maintainConfigBackups(filePath, fs),
    async () => undefined,
  );
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2), {
    mode: 0o600,
    ensureDirMode: 0o700,
    appendTrailingNewline: true,
  });
}

export async function persistPluginConfigWrite(nextConfig: OpenClawConfig): Promise<void> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const includePath = resolvePluginsIncludePath(snapshot.path, snapshot.parsed);
  if (!snapshot.valid || !includePath) {
    await writeConfigFile(nextConfig, writeOptions);
    return;
  }
  const validatedConfig = validateConfigForPluginWrite(nextConfig);
  const changedRootKeys = resolveChangedRootKeys(snapshot.config, validatedConfig);
  const nextRootSource =
    changedRootKeys.length > 0
      ? buildUpdatedRootSource(snapshot.parsed, validatedConfig, changedRootKeys)
      : null;
  if (changedRootKeys.length > 0 && !nextRootSource) {
    await writeConfigFile(validatedConfig, writeOptions);
    return;
  }
  await ensureIncludedPluginsFileIsReadable(includePath);
  await writePluginsIncludeFile(
    includePath,
    validatedConfig.plugins,
    writeOptions.envSnapshotForRestore,
  );
  if (nextRootSource) {
    const nextRootValue = await restoreConfigFragmentEnvRefs(
      snapshot.path,
      nextRootSource,
      writeOptions.envSnapshotForRestore,
    );
    await writeConfigFragment(snapshot.path, nextRootValue);
  }
  clearConfigCache();
}
