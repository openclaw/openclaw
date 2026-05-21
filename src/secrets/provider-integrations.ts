import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "../plugins/config-state.js";
import { shouldRejectHardlinkedPluginFiles } from "../plugins/hardlink-policy.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestSecretProviderIntegration } from "../plugins/manifest.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isValidSecretProviderAlias } from "./ref-contract.js";

export type SecretProviderIntegrationPreset = {
  id: string;
  pluginId: string;
  providerAlias: string;
  displayName: string;
  description?: string;
  providerConfig: SecretProviderConfig;
};

const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
const NODE_COMMAND_PLACEHOLDER = "${node}";

function isPortableAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

function isPathInsideOrEqual(rootDir: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidate));
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolvePluginRelativePath(value: string, pluginRoot: string): string | undefined {
  const resolved = path.resolve(pluginRoot, value);
  return isPathInsideOrEqual(pluginRoot, resolved) ? resolved : undefined;
}

function isPluginRelativeEntrypoint(value: string): boolean {
  return value.startsWith("./");
}

function resolveCommand(command: string, pluginRoot: string): string | undefined {
  if (command === NODE_COMMAND_PLACEHOLDER) {
    return process.execPath;
  }
  if (isPortableAbsolutePath(command)) {
    return isPathInsideOrEqual(pluginRoot, command) ? command : undefined;
  }
  return resolvePluginRelativePath(command, pluginRoot);
}

function resolveArg(arg: string, pluginRoot: string): string | undefined {
  if (!arg.startsWith("./") && !arg.startsWith("../")) {
    return arg;
  }
  return resolvePluginRelativePath(arg, pluginRoot);
}

function withNodeCommandTrustedDir(command: string, pluginRoot: string): string[] {
  return command === NODE_COMMAND_PLACEHOLDER
    ? [...new Set([path.dirname(process.execPath), pluginRoot])]
    : [pluginRoot];
}

function resolveNodeEntrypointArg(params: {
  integration: PluginManifestSecretProviderIntegration;
  pluginRoot: string;
  rejectHardlinks: boolean;
}): string | undefined {
  const entrypoint = params.integration.args?.[0];
  if (!entrypoint || !isPluginRelativeEntrypoint(entrypoint)) {
    return undefined;
  }
  let pluginRootRealpath: string;
  try {
    pluginRootRealpath = fs.realpathSync(params.pluginRoot);
  } catch {
    return undefined;
  }
  const resolved = resolvePluginRelativePath(entrypoint, params.pluginRoot);
  if (!resolved) {
    return undefined;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return undefined;
  }
  if (params.rejectHardlinks && stat.nlink > 1) {
    return undefined;
  }
  if (
    params.integration.allowInsecurePath !== true &&
    process.platform !== "win32" &&
    (stat.mode & 0o022) !== 0
  ) {
    return undefined;
  }
  if (
    params.integration.allowInsecurePath !== true &&
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    typeof stat.uid === "number" &&
    stat.uid !== process.getuid() &&
    stat.uid !== 0
  ) {
    return undefined;
  }
  try {
    const realpath = fs.realpathSync(resolved);
    return isPathInsideOrEqual(pluginRootRealpath, realpath) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function materializeExecProviderConfig(
  integration: PluginManifestSecretProviderIntegration,
  record: PluginManifestRecord,
  env: NodeJS.ProcessEnv,
): SecretProviderConfig | undefined {
  const pluginRoot = record.rootDir;
  const command = resolveCommand(integration.command, pluginRoot);
  if (!command) {
    return undefined;
  }
  const nodeEntrypoint =
    integration.command === NODE_COMMAND_PLACEHOLDER
      ? resolveNodeEntrypointArg({
          integration,
          pluginRoot,
          rejectHardlinks: shouldRejectHardlinkedPluginFiles({
            origin: record.origin,
            rootDir: pluginRoot,
            env,
          }),
        })
      : undefined;
  if (integration.command === NODE_COMMAND_PLACEHOLDER && !nodeEntrypoint) {
    return undefined;
  }
  const args = integration.args
    ?.map((arg, index) =>
      nodeEntrypoint && index === 0 ? nodeEntrypoint : resolveArg(arg, pluginRoot),
    )
    .filter((arg): arg is string => arg !== undefined);
  if (integration.args && args?.length !== integration.args.length) {
    return undefined;
  }
  const trustedDirs = withNodeCommandTrustedDir(integration.command, pluginRoot);
  return {
    source: "exec",
    command,
    ...(args ? { args } : {}),
    ...(integration.timeoutMs !== undefined ? { timeoutMs: integration.timeoutMs } : {}),
    ...(integration.noOutputTimeoutMs !== undefined
      ? { noOutputTimeoutMs: integration.noOutputTimeoutMs }
      : {}),
    ...(integration.maxOutputBytes !== undefined
      ? { maxOutputBytes: integration.maxOutputBytes }
      : {}),
    ...(integration.jsonOnly === false ? { jsonOnly: false } : {}),
    ...(integration.env ? { env: integration.env } : {}),
    ...(integration.passEnv ? { passEnv: integration.passEnv } : {}),
    trustedDirs,
    ...(integration.allowInsecurePath ? { allowInsecurePath: true } : {}),
    ...(integration.allowSymlinkCommand ? { allowSymlinkCommand: true } : {}),
  };
}

function canExposeSecretProviderIntegrations(params: {
  record: PluginManifestRecord;
  normalizedConfig: NormalizedPluginsConfig;
  config: OpenClawConfig;
}): boolean {
  if (params.record.origin !== "bundled" && params.record.origin !== "global") {
    return false;
  }
  return isActivatedManifestOwner({
    plugin: params.record,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.config,
  });
}

function integrationDisplayName(
  record: PluginManifestRecord,
  integrationId: string,
  integration: PluginManifestSecretProviderIntegration,
): string {
  return (
    normalizeOptionalString(integration.displayName) ??
    normalizeOptionalString(record.name) ??
    integrationId
  );
}

export function listSecretProviderIntegrationPresets(params: {
  manifestRegistry: Pick<PluginManifestRegistry, "plugins">;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): SecretProviderIntegrationPreset[] {
  const presets: SecretProviderIntegrationPreset[] = [];
  const config = params.config ?? {};
  const normalizedConfig = normalizePluginsConfig(config.plugins);
  const env = params.env ?? process.env;
  for (const record of params.manifestRegistry.plugins) {
    if (!canExposeSecretProviderIntegrations({ record, normalizedConfig, config })) {
      continue;
    }
    for (const [integrationId, integration] of Object.entries(
      record.secretProviderIntegrations ?? {},
    )) {
      const providerAlias = normalizeOptionalString(integration.providerAlias) ?? integrationId;
      if (!isValidSecretProviderAlias(providerAlias)) {
        continue;
      }
      const providerConfig = materializeExecProviderConfig(integration, record, env);
      if (!providerConfig) {
        continue;
      }
      presets.push({
        id: integrationId,
        pluginId: record.id,
        providerAlias,
        displayName: integrationDisplayName(record, integrationId, integration),
        ...(integration.description ? { description: integration.description } : {}),
        providerConfig,
      });
    }
  }
  return presets.toSorted((left, right) =>
    `${left.displayName}:${left.providerAlias}`.localeCompare(
      `${right.displayName}:${right.providerAlias}`,
    ),
  );
}
