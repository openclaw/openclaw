// Maintains plugin manifest lookup tables for discovery and runtime planning.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { isForeignBundledPluginRoot } from "./bundled-dir.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import { normalizePluginsConfigWithResolver } from "./config-policy.js";
import { isBundledPluginInsideDevSourceRoot } from "./dev-source-root.js";
import {
  discoverOpenClawPlugins,
  type PluginCandidate,
  type PluginDiscoveryResult,
} from "./discovery.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import {
  matchesInstalledPluginRecord,
  resolvePluginTrust,
} from "./installed-plugin-record-match.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import { buildBundleManifestRecord, buildPluginManifestRecord } from "./manifest-record.js";
import type {
  BundledChannelConfigCollector,
  PluginManifestRecord,
  PluginManifestRegistry,
} from "./manifest-registry.types.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  isCoreReservedPluginId,
  loadPluginManifest,
  PLUGIN_MANIFEST_FILENAME,
  type PluginManifest,
} from "./manifest.js";
import { checkMinHostVersion } from "./min-host-version.js";
import { satisfiesPluginApiRange, resolvePackagePluginApiRange } from "./package-compat.js";
import {
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  readPluginCacheFile,
} from "./plugin-cache-files.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

type SeenIdEntry = {
  candidate: PluginCandidate;
  record: PluginManifestRecord;
};

// Canonicalize identical physical plugin roots with the most explicit source.
// This only applies when multiple candidates resolve to the same on-disk plugin.
const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

function rejectCaseFoldedIdCollisions(
  records: readonly PluginManifestRecord[],
  diagnostics: PluginDiagnostic[],
): PluginManifestRecord[] {
  const recordsByPolicyId = new Map<string, PluginManifestRecord[]>();
  for (const record of records) {
    const policyId = normalizePluginPolicyId(record.id);
    const matches = recordsByPolicyId.get(policyId) ?? [];
    matches.push(record);
    recordsByPolicyId.set(policyId, matches);
  }

  const rejected = new Set<PluginManifestRecord>();
  for (const [policyId, matches] of recordsByPolicyId) {
    const declaredIds = [...new Set(matches.map((record) => record.id))].toSorted();
    if (declaredIds.length < 2) {
      continue;
    }
    const message = `plugin ids ${declaredIds.map((id) => JSON.stringify(id)).join(", ")} collide as normalized id ${JSON.stringify(policyId)}; refusing all colliding plugins`;
    for (const record of matches) {
      rejected.add(record);
      diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message,
      });
    }
  }
  return records.filter((record) => !rejected.has(record));
}

function pushNonBundledChannelConfigDescriptorDiagnostic(params: {
  record: PluginManifestRecord;
  diagnostics: PluginDiagnostic[];
  normalized?: ReturnType<typeof normalizePluginsConfigWithResolver>;
}): void {
  if (params.record.origin === "bundled" || params.record.format === "bundle") {
    return;
  }
  const configuredEntry = params.normalized?.entries[params.record.id];
  if (
    params.normalized?.enabled === false ||
    configuredEntry?.enabled === false ||
    params.normalized?.deny.includes(params.record.id) ||
    (params.normalized?.allow.length && !params.normalized.allow.includes(params.record.id))
  ) {
    return;
  }
  const declaredChannels = params.record.channels
    .map((channelId) => channelId.trim())
    .filter((channelId) => channelId.length > 0);
  if (declaredChannels.length === 0) {
    return;
  }
  const channelConfigs = params.record.channelConfigs ?? {};
  const missingChannels = declaredChannels.filter(
    (channelId) => !Object.hasOwn(channelConfigs, channelId),
  );
  if (missingChannels.length === 0) {
    return;
  }
  const safeMissingChannels = missingChannels.map(sanitizeForLog);
  params.diagnostics.push({
    level: "warn",
    pluginId: sanitizeForLog(params.record.id),
    source: sanitizeForLog(params.record.manifestPath),
    message: `channel plugin manifest declares ${safeMissingChannels.join(", ")} without channelConfigs metadata; add openclaw.plugin.json#channelConfigs so config schema and setup surfaces work before runtime loads. Channels without channelConfigs still appear in channel listings, but setup UI may be limited.`,
  });
}

function dedupePluginDiagnostics(
  diagnostics: PluginDiagnostic[],
  discoveryDiagnostics: ReadonlySet<PluginDiagnostic>,
): PluginDiagnostic[] {
  const seen = new Set<string>();
  const deduped: PluginDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    // Discovery diagnostics belong to package roots; generated compatibility warnings belong to ids.
    const key = JSON.stringify([
      diagnostic.level,
      diagnostic.pluginId ?? "",
      diagnostic.message,
      diagnostic.level === "error" || discoveryDiagnostics.has(diagnostic)
        ? (diagnostic.source ?? "")
        : "",
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
}

function isStaleForeignBundledPin(params: {
  candidate: PluginCandidate;
  env: NodeJS.ProcessEnv;
}): boolean {
  return (
    isForeignBundledPluginRoot(params.candidate.rootDir, params.env) &&
    !isBundledPluginInsideDevSourceRoot({ rootDir: params.candidate.rootDir, env: params.env })
  );
}

function resolveDuplicatePrecedenceRank(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): number {
  if (params.candidate.origin === "config" || params.candidate.configSelected) {
    return 0;
  }
  if (
    params.candidate.origin === "bundled" &&
    isBundledPluginInsideDevSourceRoot({
      rootDir: params.candidate.rootDir,
      env: params.env,
    })
  ) {
    return 1;
  }
  if (
    params.candidate.origin === "global" &&
    !isStaleForeignBundledPin({ candidate: params.candidate, env: params.env }) &&
    matchesInstalledPluginRecord({
      pluginId: params.pluginId,
      candidate: params.candidate,
      config: params.config,
      env: params.env,
      installRecords: params.installRecords,
    })
  ) {
    return 2;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids are reserved unless the operator explicitly overrides them.
    return 3;
  }
  if (params.candidate.origin === "workspace") {
    return 4;
  }
  return 5;
}

function isIntentionalInstalledBundledDuplicate(params: {
  pluginId: string;
  left: PluginCandidate;
  right: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  const leftIsInstalled = matchesInstalledPluginRecord({
    pluginId: params.pluginId,
    candidate: params.left,
    config: params.config,
    env: params.env,
    installRecords: params.installRecords,
  });
  const rightIsInstalled = matchesInstalledPluginRecord({
    pluginId: params.pluginId,
    candidate: params.right,
    config: params.config,
    env: params.env,
    installRecords: params.installRecords,
  });
  return (
    (leftIsInstalled &&
      !isStaleForeignBundledPin({ candidate: params.left, env: params.env }) &&
      params.right.origin === "bundled" &&
      !isBundledPluginInsideDevSourceRoot({ rootDir: params.right.rootDir, env: params.env })) ||
    (rightIsInstalled &&
      !isStaleForeignBundledPin({ candidate: params.right, env: params.env }) &&
      params.left.origin === "bundled" &&
      !isBundledPluginInsideDevSourceRoot({ rootDir: params.left.rootDir, env: params.env }))
  );
}

function isSameGlobalPackageDuplicate(left: PluginCandidate, right: PluginCandidate): boolean {
  if (left.origin !== "global" || right.origin !== "global") {
    return false;
  }
  const leftPackageName = normalizeOptionalString(left.packageName);
  const rightPackageName = normalizeOptionalString(right.packageName);
  if (!leftPackageName || leftPackageName !== rightPackageName) {
    return false;
  }
  const leftPackageVersion = normalizeOptionalString(left.packageVersion);
  const rightPackageVersion = normalizeOptionalString(right.packageVersion);
  return Boolean(
    leftPackageVersion && rightPackageVersion && leftPackageVersion === rightPackageVersion,
  );
}

export type PluginManifestRegistryBuildParams = {
  registryPath?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  candidates?: PluginCandidate[];
  diagnostics?: PluginDiagnostic[];
  getInstallRecords: () => Record<string, PluginInstallRecord>;
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
  discovery?: PluginDiscoveryResult;
};

export function buildPluginManifestRegistry(
  params: PluginManifestRegistryBuildParams,
): PluginManifestRegistry {
  const config = params.config ?? {};
  const normalized = normalizePluginsConfigWithResolver(config.plugins);
  const env = params.env ?? process.env;
  const registryPath = params.registryPath ?? resolveInstalledPluginIndexStorePath({ env });
  const { getInstallRecords } = params;

  const discovery = params.candidates
    ? {
        candidates: params.candidates,
        diagnostics: params.diagnostics ?? [],
      }
    : (params.discovery ??
      discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalized.loadPaths,
        env,
        installRecords: getInstallRecords(),
      }));
  const discovered = new Set(discovery.diagnostics);
  const diagnostics: PluginDiagnostic[] = [...discovered];
  const candidates: PluginCandidate[] = discovery.candidates;
  const seenIds = new Map<string, SeenIdEntry>();
  const currentHostVersion = resolveCompatibilityHostVersion(env);
  const explicitConfiguredFileSources = new Set(
    normalized.loadPaths
      .map((loadPath) => resolveUserPath(loadPath, env))
      .filter((loadPath) => pluginCacheStatSync(loadPath)?.isFile() === true)
      .map((loadPath) => path.resolve(loadPath)),
  );

  for (const candidate of candidates) {
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: candidate.origin,
      rootDir: candidate.rootDir,
      env,
    });
    const isBundleRecord = (candidate.format ?? "openclaw") === "bundle";
    const isManifestlessConfiguredFile =
      candidate.origin === "config" &&
      explicitConfiguredFileSources.has(path.resolve(candidate.source)) &&
      !pluginCacheExistsSync(path.join(candidate.rootDir, PLUGIN_MANIFEST_FILENAME));
    if (isManifestlessConfiguredFile && isCoreReservedPluginId(candidate.idHint)) {
      diagnostics.push({
        level: "error",
        pluginId: candidate.idHint,
        source: candidate.source,
        message: `plugin manifest id "${candidate.idHint}" is reserved by OpenClaw core`,
      });
      continue;
    }
    const manifestRes:
      | ReturnType<typeof loadPluginManifest>
      | ReturnType<typeof loadBundleManifest>
      | { ok: true; manifest: PluginManifest; manifestPath: string } =
      candidate.origin === "bundled" && candidate.bundledManifest && candidate.bundledManifestPath
        ? {
            ok: true,
            manifest: candidate.bundledManifest,
            manifestPath: candidate.bundledManifestPath,
          }
        : isBundleRecord && candidate.bundleFormat
          ? loadBundleManifest({
              rootDir: candidate.rootDir,
              bundleFormat: candidate.bundleFormat,
              rejectHardlinks,
            })
          : isManifestlessConfiguredFile
            ? {
                ok: true,
                manifest: {
                  id: candidate.idHint,
                  configSchema: { type: "object", additionalProperties: false },
                },
                manifestPath: candidate.source,
              }
            : loadPluginManifest(candidate.rootDir, rejectHardlinks);
    if (!manifestRes.ok) {
      diagnostics.push({
        level: "error",
        pluginId: candidate.diagnosticIdHint ?? candidate.idHint,
        message: manifestRes.error,
        source: manifestRes.manifestPath,
        ...("diagnosticCode" in manifestRes && manifestRes.diagnosticCode
          ? { code: manifestRes.diagnosticCode }
          : {}),
      });
      continue;
    }
    const manifest = manifestRes.manifest;
    const effectivePluginId = candidate.effectivePluginId ?? manifest.id;
    if (candidate.origin !== "bundled") {
      const packageManifestSource = path.join(
        candidate.packageDir ?? candidate.rootDir,
        "package.json",
      );
      const allowLegacyBareMinHostVersion =
        candidate.origin === "global" &&
        matchesInstalledPluginRecord({
          pluginId: effectivePluginId,
          candidate,
          config,
          env,
          installRecords: getInstallRecords(),
        });
      const minHostVersionCheck = checkMinHostVersion({
        currentVersion: currentHostVersion,
        minHostVersion: candidate.packageManifest?.install?.minHostVersion,
        allowLegacyBareSemver: allowLegacyBareMinHostVersion,
      });
      if (!minHostVersionCheck.ok) {
        diagnostics.push({
          level: minHostVersionCheck.kind === "invalid" ? "error" : "warn",
          pluginId: effectivePluginId,
          source: packageManifestSource,
          message:
            minHostVersionCheck.kind === "invalid"
              ? `plugin manifest invalid | ${minHostVersionCheck.error}`
              : minHostVersionCheck.kind === "unknown_host_version"
                ? `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined; skipping load`
                : `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}; skipping load`,
        });
        continue;
      }
      const packagePluginApiRangeCheck = resolvePackagePluginApiRange(candidate.packageManifest);
      if (!packagePluginApiRangeCheck.ok) {
        diagnostics.push({
          level: "error",
          pluginId: effectivePluginId,
          source: packageManifestSource,
          message: `plugin manifest invalid | ${packagePluginApiRangeCheck.error}`,
        });
        continue;
      }
      const packagePluginApiRange = packagePluginApiRangeCheck.range;
      if (
        packagePluginApiRange &&
        !satisfiesPluginApiRange(currentHostVersion, packagePluginApiRange)
      ) {
        diagnostics.push({
          level: "warn",
          pluginId: effectivePluginId,
          source: packageManifestSource,
          message: `plugin requires plugin API ${packagePluginApiRange}, but this host is ${currentHostVersion}; skipping load (check "openclaw --version", OPENCLAW_COMPATIBILITY_HOST_VERSION, or run "openclaw doctor")`,
        });
        continue;
      }
    }

    const configSchema = "configSchema" in manifest ? manifest.configSchema : undefined;
    const schemaCacheKey = (() => {
      if (!configSchema || isManifestlessConfiguredFile) {
        return undefined;
      }
      const file = readPluginCacheFile({
        rootDir: candidate.rootDir,
        relativePath: path.relative(candidate.rootDir, manifestRes.manifestPath),
        rejectHardlinks,
        maxBytes: 256 * 1024,
      });
      return file.ok ? `${manifestRes.manifestPath}:${file.hash}` : manifestRes.manifestPath;
    })();

    const record = isBundleRecord
      ? buildBundleManifestRecord({
          // SAFETY: discovery pairs bundle candidates with the bundle parser above.
          manifest: manifest as Parameters<typeof buildBundleManifestRecord>[0]["manifest"],
          candidate,
          manifestPath: manifestRes.manifestPath,
          rejectHardlinks,
        })
      : buildPluginManifestRecord({
          // SAFETY: native candidates use the native parser or equivalent manifestless shape above.
          manifest: manifest as PluginManifest,
          candidate,
          manifestPath: manifestRes.manifestPath,
          diagnostics,
          rejectHardlinks,
          schemaCacheKey,
          configSchema,
          trust: resolvePluginTrust({
            registryPath,
            pluginId: effectivePluginId,
            candidate,
            env,
            installRecords: getInstallRecords(),
          }),
          ...(params.bundledChannelConfigCollector
            ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector }
            : {}),
        });
    if (candidate.sourcePreferred || (candidate.origin === "bundled" && candidate.configSelected)) {
      record.sourcePreferred = true;
    }
    recordPluginManifestInstallOwner(
      record,
      resolvePluginCandidateInstallOwner(candidate),
      isPluginCandidateInstallOwnerAmbiguous(candidate),
    );
    const existing = seenIds.get(effectivePluginId);
    if (existing) {
      // Check whether both candidates point to the same physical directory
      // (e.g. via symlinks or different path representations). If so, this
      // is a false-positive duplicate and can be silently skipped.
      const samePath = existing.candidate.rootDir === candidate.rootDir;
      const samePlugin = (() => {
        if (samePath) {
          return true;
        }
        const existingReal = pluginCacheRealpathSync(existing.candidate.rootDir);
        const candidateReal = pluginCacheRealpathSync(candidate.rootDir);
        return Boolean(existingReal && candidateReal && existingReal === candidateReal);
      })();
      if (samePlugin) {
        if (record.sourcePreferred || existing.record.sourcePreferred) {
          record.sourcePreferred = true;
          existing.record.sourcePreferred = true;
        }
        // Prefer higher-precedence origins even if candidates are passed in
        // an unexpected order (config > workspace > global > bundled).
        if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
          seenIds.set(effectivePluginId, { candidate, record });
        }
        continue;
      }

      const candidateRank = resolveDuplicatePrecedenceRank({
        pluginId: effectivePluginId,
        candidate,
        config,
        env,
        installRecords: getInstallRecords(),
      });
      const existingRank = resolveDuplicatePrecedenceRank({
        pluginId: effectivePluginId,
        candidate: existing.candidate,
        config,
        env,
        installRecords: getInstallRecords(),
      });
      const candidateWins = candidateRank < existingRank;
      const winnerCandidate = candidateWins ? candidate : existing.candidate;
      const overriddenCandidate = candidateWins ? existing.candidate : candidate;
      if (candidateWins) {
        seenIds.set(effectivePluginId, { candidate, record });
      }
      if (
        isIntentionalInstalledBundledDuplicate({
          pluginId: effectivePluginId,
          left: candidate,
          right: existing.candidate,
          config,
          env,
          installRecords: getInstallRecords(),
        })
      ) {
        continue;
      }
      if (isSameGlobalPackageDuplicate(candidate, existing.candidate)) {
        continue;
      }
      const staleForeignPin =
        winnerCandidate.origin === "bundled" &&
        isStaleForeignBundledPin({ candidate: overriddenCandidate, env }) &&
        matchesInstalledPluginRecord({
          pluginId: effectivePluginId,
          candidate: overriddenCandidate,
          env,
          installRecords: getInstallRecords(),
        });
      diagnostics.push({
        level: "warn",
        pluginId: effectivePluginId,
        source: overriddenCandidate.source,
        message: staleForeignPin
          ? `stale plugin install record: "${effectivePluginId}" is pinned to ${overriddenCandidate.rootDir}, which belongs to a different OpenClaw installation. This installation's bundled plugin is being used instead. No uninstall is needed to use the bundled plugin. Uninstalling, even with \`--keep-files\`, removes plugin configuration; re-enabling does not restore it.`
          : winnerCandidate.origin === "config"
            ? `duplicate plugin id resolved by explicit config-selected plugin; ${overriddenCandidate.origin} plugin will be overridden by config plugin (${winnerCandidate.source})`
            : `duplicate plugin id detected; ${overriddenCandidate.origin} plugin will be overridden by ${winnerCandidate.origin} plugin (${winnerCandidate.source})`,
      });
      continue;
    }

    seenIds.set(effectivePluginId, { candidate, record });
  }

  const records = [...seenIds.values()].map(({ record }) => record);
  const plugins = rejectCaseFoldedIdCollisions(records, diagnostics);
  for (const record of plugins) {
    pushNonBundledChannelConfigDescriptorDiagnostic({ record, diagnostics, normalized });
  }
  const registry = { plugins, diagnostics: dedupePluginDiagnostics(diagnostics, discovered) };
  return registry;
}

/** Load manifest metadata from the bundled/source plugin tree without consulting operator state. */
export function loadBundledPluginManifestRegistry(
  params: { env?: NodeJS.ProcessEnv; bundledRoot?: string } = {},
): PluginManifestRegistry {
  const env = params.env ?? process.env;
  const installRecords: Record<string, PluginInstallRecord> = {};
  return buildPluginManifestRegistry({
    env,
    getInstallRecords: () => installRecords,
    discovery: discoverOpenClawPlugins({
      env,
      installRecords,
      rootScope: "bundled",
      ...(params.bundledRoot ? { bundledRoot: params.bundledRoot } : {}),
    }),
  });
}
