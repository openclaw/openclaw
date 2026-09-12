// Owns source-aware config snapshots and recovery for plugin installation.
import fs from "node:fs";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { PluginsInstallParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";
import { findBundledPluginSource } from "./bundled-sources.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  supportsInstallConfigSingleTopLevelIncludeShape,
  type ConfigMutationPreflight,
  type ConfigSnapshotForInstallPersist,
} from "./install-config-mutation.js";
import {
  parseNpmPrefixSpec,
  resolveBundledInstallPlanBeforeNpm,
  resolveFileNpmSpecToLocalPath,
} from "./install-source-spec.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { listPersistedBundledPluginRecoveryLocations } from "./location-bridges.js";
import { loadPluginManifest } from "./manifest.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";
import { tracePluginLifecyclePhaseAsync } from "./plugin-lifecycle-trace.js";

export type ConfigSnapshotForInstallExecution = ConfigSnapshotForInstallPersist & {
  hookMutation: ConfigMutationPreflight;
  pluginMutation: ConfigMutationPreflight;
};

export function resolveFullyBlockedConfigMutationReason(
  snapshot: ConfigSnapshotForInstallExecution,
): string | null {
  if (snapshot.pluginMutation.mode !== "blocked" || snapshot.hookMutation.mode !== "blocked") {
    return null;
  }
  if (snapshot.pluginMutation.reason === snapshot.hookMutation.reason) {
    return snapshot.pluginMutation.reason;
  }
  return `Config plugin and hook mutations are both blocked. ${snapshot.pluginMutation.reason} ${snapshot.hookMutation.reason}`;
}

export class PluginInstallConfigError extends Error {
  readonly code = "INVALID_CONFIG";
  constructor(
    message: string,
    readonly blockedSnapshot?: ConfigSnapshotForInstallExecution,
  ) {
    super(message);
    this.name = "PluginInstallConfigError";
  }
}

function extractMissingPluginLoadPath(issue: ConfigValidationIssue): string | null {
  if (issue.path !== "plugins.load.paths") {
    return null;
  }
  const marker = "plugin path not found:";
  const markerIndex = issue.message.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const value = issue.message.slice(markerIndex + marker.length).trim();
  return value || null;
}

function isOwnedMissingPluginLoadPathIssue(
  issue: ConfigValidationIssue,
  ownedLoadPaths: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const missingPath = extractMissingPluginLoadPath(issue);
  return missingPath !== null && ownedLoadPaths.has(resolveUserPath(missingPath, env));
}

function isAllowedPluginRecoveryIssue(
  issue: ConfigValidationIssue,
  request: PluginInstallRequestContext,
  ownedLoadPaths: ReadonlySet<string>,
): boolean {
  const pluginId = request.bundledPluginId?.trim();
  if (!pluginId) {
    return false;
  }
  return (
    (issue.path === `channels.${pluginId}` &&
      issue.message === `unknown channel id: ${pluginId}`) ||
    // The outgoing schema must not block its replacement. The validator names
    // the schema owner; a plugin may own a channel whose id differs from its own.
    (issue.path.startsWith("channels.") &&
      issue.message.startsWith(`invalid config for plugin ${pluginId}:`)) ||
    isOwnedMissingPluginLoadPathIssue(issue, ownedLoadPaths) ||
    (issue.path === `plugins.entries.${pluginId}` &&
      issue.message.includes("requires compiled runtime output")) ||
    (issue.path === "tools.web.search.provider" && issue.message.includes(`plugin "${pluginId}"`))
  );
}

function removeOwnedMissingPluginLoadPaths(
  cfg: OpenClawConfig,
  issues: readonly ConfigValidationIssue[],
  ownedLoadPaths: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): OpenClawConfig {
  const missingPaths = new Set<string>();
  for (const issue of issues) {
    const missingPath = extractMissingPluginLoadPath(issue);
    if (!missingPath) {
      continue;
    }
    const resolved = resolveUserPath(missingPath, env);
    if (ownedLoadPaths.has(resolved)) {
      missingPaths.add(resolved);
    }
  }
  const paths = cfg.plugins?.load?.paths;
  if (missingPaths.size === 0 || !Array.isArray(paths)) {
    return cfg;
  }
  const nextPaths = paths.filter(
    (entry) => typeof entry !== "string" || !missingPaths.has(resolveUserPath(entry, env)),
  );
  if (nextPaths.length === paths.length) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      load: {
        ...cfg.plugins?.load,
        paths: nextPaths,
      },
    },
  };
}

async function resolveRequestedPluginInstallPaths(
  cfg: OpenClawConfig,
  issues: readonly ConfigValidationIssue[],
  request: PluginInstallRequestContext,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  if (!issues.some((issue) => extractMissingPluginLoadPath(issue) !== null)) {
    return new Set();
  }
  const installRecords = await loadInstalledPluginIndexInstallRecords();
  const ownedLoadPaths = new Set<string>();
  const pluginId = request.bundledPluginId?.trim();
  if (!pluginId) {
    return ownedLoadPaths;
  }
  const record = installRecords[pluginId] ?? cfg.plugins?.installs?.[pluginId];
  for (const value of [record?.sourcePath, record?.installPath]) {
    if (typeof value === "string" && value.trim()) {
      ownedLoadPaths.add(resolveUserPath(value, env));
    }
  }
  const stillNeedsLocationBridge = issues.some(
    (issue) =>
      extractMissingPluginLoadPath(issue) !== null &&
      !isOwnedMissingPluginLoadPathIssue(issue, ownedLoadPaths, env),
  );
  if (stillNeedsLocationBridge) {
    // Registry ownership, not a matching requested id, authorizes repairing a removed path.
    const locations = await listPersistedBundledPluginRecoveryLocations({ env });
    const loadPaths = locations
      .filter((location) => location.pluginId === pluginId)
      .flatMap((location) => location.loadPaths);
    for (const loadPath of loadPaths) {
      ownedLoadPaths.add(resolveUserPath(loadPath, env));
    }
  }
  return ownedLoadPaths;
}

async function recoverPluginInstallConfig(
  request: PluginInstallRequestContext,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>["snapshot"],
): Promise<OpenClawConfig> {
  if (resolvePluginInstallInvalidConfigPolicy(request) !== "allow-plugin-recovery") {
    throw new PluginInstallConfigError(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
  }
  const parsed = snapshot.parsed ?? {};
  if (!snapshot.exists || Object.keys(parsed).length === 0) {
    throw new PluginInstallConfigError(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  }
  const ownedLoadPaths = await resolveRequestedPluginInstallPaths(
    snapshot.config,
    snapshot.issues,
    request,
    process.env,
  );
  if (
    snapshot.legacyIssues.length > 0 ||
    snapshot.issues.length === 0 ||
    snapshot.issues.some((issue) => !isAllowedPluginRecoveryIssue(issue, request, ownedLoadPaths))
  ) {
    const pluginLabel = request.bundledPluginId ?? "the requested plugin";
    throw new PluginInstallConfigError(
      `Config invalid outside the plugin recovery path for ${pluginLabel}; run \`openclaw doctor --fix\` before reinstalling it.`,
    );
  }
  if (
    Object.hasOwn(parsed, "$include") ||
    !supportsInstallConfigSingleTopLevelIncludeShape(isRecord(parsed) ? parsed.plugins : undefined)
  ) {
    throw new PluginInstallConfigError(
      "Config plugin recovery uses an unsupported $include shape; use a single-file top-level plugins include or run `openclaw doctor --fix` before reinstalling it.",
    );
  }
  return removeOwnedMissingPluginLoadPaths(
    snapshot.config,
    snapshot.issues,
    ownedLoadPaths,
    process.env,
  );
}

/** Read and authorize install configuration only after mutation-free request preflight. */
export async function loadConfigForInstall(
  request: PluginInstallRequestContext,
): Promise<ConfigSnapshotForInstallExecution> {
  const prepared = await tracePluginLifecyclePhaseAsync(
    "config read",
    () => readConfigFileSnapshotForWrite(),
    { command: "install" },
  );
  const { snapshot, writeOptions } = prepared;
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  const config = snapshot.valid
    ? snapshot.sourceConfig
    : await recoverPluginInstallConfig(request, snapshot);
  const parsed = asRecord(snapshot.parsed);
  const { hookMutation, pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed,
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  const resolved = {
    config,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
    hookMutation,
    pluginMutation,
  };
  if (!snapshot.valid || request.installKind === "plugin") {
    if (pluginMutation.mode === "blocked") {
      throw new PluginInstallConfigError(pluginMutation.reason, resolved);
    }
  }
  return resolved;
}

type PluginInstallInvalidConfigPolicy = "deny" | "allow-plugin-recovery";

/** Parsed install request plus recovery metadata needed by CLI pre-action config policy. */
export type PluginInstallRequestContext = {
  rawSpec: string;
  installKind?: "plugin";
  marketplace?: string;
  bundledPluginId?: string;
  allowInvalidConfigRecovery?: boolean;
};

type PluginInstallRequestResolution =
  | { ok: true; request: PluginInstallRequestContext }
  | { ok: false; error: string };

function readPluginInstallRecoveryMetadata(rootDir: string): {
  pluginId?: string;
  allowInvalidConfigRecovery: boolean;
} {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return { allowInvalidConfigRecovery: false };
  }
  const manifest = loadPluginManifest(rootDir, false);
  const pluginId = manifest.ok ? manifest.manifest.id : undefined;
  const parsed = tryReadJsonSync<{
    openclaw?: {
      install?: {
        allowInvalidConfigRecovery?: boolean;
      };
    };
  }>(packageJsonPath);
  return {
    ...(pluginId ? { pluginId } : {}),
    allowInvalidConfigRecovery: parsed?.openclaw?.install?.allowInvalidConfigRecovery === true,
  };
}

function resolvePluginInstallRecoveryMetadata(
  rawSpec: string,
  localPath: string | undefined,
): {
  pluginId?: string;
  allowInvalidConfigRecovery?: boolean;
} {
  // A local or file: request must never inherit recovery authority from a catalog name.
  if (localPath !== undefined) {
    const direct = readPluginInstallRecoveryMetadata(localPath);
    return direct.pluginId || direct.allowInvalidConfigRecovery ? direct : {};
  }
  const npmPrefixSpec = parseNpmPrefixSpec(rawSpec);
  const values = new Set(
    normalizeStringEntries([
      rawSpec,
      npmPrefixSpec ?? "",
      parseRegistryNpmSpec(rawSpec)?.name ?? "",
      npmPrefixSpec ? parseRegistryNpmSpec(npmPrefixSpec)?.name : "",
    ]),
  );
  if (values.size === 0) {
    return {};
  }
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const install = resolveOfficialExternalPluginInstall(entry);
    const npmSpec = install?.npmSpec?.trim() || entry.name?.trim();
    if (!npmSpec || !values.has(npmSpec)) {
      continue;
    }
    const pluginId = resolveOfficialExternalPluginId(entry);
    // An official descriptor owns this decision even when recovery is explicitly disabled.
    return {
      ...(pluginId ? { pluginId } : {}),
      allowInvalidConfigRecovery: install?.allowInvalidConfigRecovery === true,
    };
  }
  return {};
}

/** Resolve install metadata from the raw spec before Commander action handlers mutate config. */
export function resolvePluginInstallRequestContext(params: {
  rawSpec: string;
  source?: PluginsInstallParams["source"];
  localPath?: string;
  marketplace?: string;
  installKind?: "plugin";
}): PluginInstallRequestResolution {
  if (params.marketplace) {
    return {
      ok: true,
      request: {
        rawSpec: params.rawSpec,
        installKind: "plugin",
        marketplace: params.marketplace,
      },
    };
  }
  const fileSpec = resolveFileNpmSpecToLocalPath(params.rawSpec);
  if (fileSpec && !fileSpec.ok) {
    return {
      ok: false,
      error: fileSpec.error,
    };
  }
  const normalizedSpec = fileSpec && fileSpec.ok ? fileSpec.path : params.rawSpec;
  const resolvedPath = resolveUserPath(params.localPath ?? normalizedSpec);
  const localPath = params.source
    ? params.source === "local" || params.source === "bundled"
      ? resolvedPath
      : undefined
    : fileSpec || fs.existsSync(resolvedPath)
      ? resolvedPath
      : resolveBundledInstallPlanBeforeNpm({
          rawSpec: params.rawSpec,
          findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
        })?.bundledSource.localPath;
  const recovered = resolvePluginInstallRecoveryMetadata(params.rawSpec, localPath);
  return {
    ok: true,
    request: {
      rawSpec: params.rawSpec,
      ...(params.installKind === "plugin" || recovered.pluginId ? { installKind: "plugin" } : {}),
      ...(recovered.pluginId ? { bundledPluginId: recovered.pluginId } : {}),
      ...(recovered.allowInvalidConfigRecovery !== undefined
        ? { allowInvalidConfigRecovery: recovered.allowInvalidConfigRecovery }
        : {}),
    },
  };
}

/** Decide whether invalid config should block a command before plugin recovery can run. */
export function resolvePluginInstallInvalidConfigPolicy(
  request: PluginInstallRequestContext | null,
): PluginInstallInvalidConfigPolicy {
  if (!request) {
    return "deny";
  }
  return request.allowInvalidConfigRecovery === true ? "allow-plugin-recovery" : "deny";
}
