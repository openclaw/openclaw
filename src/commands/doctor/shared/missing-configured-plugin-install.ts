import { listChannelPluginCatalogEntries } from "../../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { CLAWHUB_INSTALL_ERROR_CODE, installPluginFromClawHub } from "../../../plugins/clawhub.js";
import { resolveDefaultPluginExtensionsDir } from "../../../plugins/install-paths.js";
import { installPluginFromNpmSpec } from "../../../plugins/install.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields } from "../../../plugins/installs.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { updateNpmInstalledPlugins } from "../../../plugins/update.js";
import { asObjectRecord } from "./object.js";

type DownloadableInstallCandidate = {
  pluginId: string;
  label: string;
  clawhubSpec?: string;
  npmSpec?: string;
  expectedIntegrity?: string;
};

function shouldFallbackClawHubCandidateToNpm(result: { ok: false; code?: string }): boolean {
  return (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND
  );
}

function collectConfiguredPluginIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const plugins = asObjectRecord(cfg.plugins);
  const allow = Array.isArray(plugins?.allow) ? plugins.allow : [];
  for (const value of allow) {
    if (typeof value === "string" && value.trim()) {
      ids.add(value.trim());
    }
  }
  const entries = asObjectRecord(plugins?.entries);
  for (const pluginId of Object.keys(entries ?? {})) {
    if (pluginId.trim()) {
      ids.add(pluginId.trim());
    }
  }
  return ids;
}

function collectConfiguredChannelIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const channels = asObjectRecord(cfg.channels);
  for (const channelId of Object.keys(channels ?? {})) {
    if (channelId !== "defaults" && channelId.trim()) {
      ids.add(channelId.trim());
    }
  }
  return ids;
}

function collectDownloadableInstallCandidates(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  missingPluginIds: ReadonlySet<string>;
}): DownloadableInstallCandidate[] {
  const configuredPluginIds = collectConfiguredPluginIds(params.cfg);
  const configuredChannelIds = collectConfiguredChannelIds(params.cfg);
  const candidates = new Map<string, DownloadableInstallCandidate>();

  for (const entry of listChannelPluginCatalogEntries({
    env: params.env,
    excludeWorkspace: true,
  })) {
    const pluginId = entry.pluginId ?? entry.id;
    if (
      !params.missingPluginIds.has(pluginId) &&
      !configuredPluginIds.has(pluginId) &&
      !configuredChannelIds.has(entry.id)
    ) {
      continue;
    }
    const clawhubSpec = entry.install.clawhubSpec?.trim();
    const npmSpec = entry.install.npmSpec?.trim();
    if (!clawhubSpec && !npmSpec) {
      continue;
    }
    candidates.set(pluginId, {
      pluginId,
      label: entry.meta.label,
      ...(clawhubSpec ? { clawhubSpec } : {}),
      ...(npmSpec ? { npmSpec } : {}),
      ...(entry.install.expectedIntegrity
        ? { expectedIntegrity: entry.install.expectedIntegrity }
        : {}),
    });
  }

  for (const entry of resolveProviderInstallCatalogEntries({
    config: params.cfg,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  })) {
    if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) {
      continue;
    }
    const clawhubSpec = entry.install.clawhubSpec?.trim();
    const npmSpec = entry.install.npmSpec?.trim();
    if (!clawhubSpec && !npmSpec) {
      continue;
    }
    candidates.set(entry.pluginId, {
      pluginId: entry.pluginId,
      label: entry.label,
      ...(clawhubSpec ? { clawhubSpec } : {}),
      ...(npmSpec ? { npmSpec } : {}),
      ...(entry.install.expectedIntegrity
        ? { expectedIntegrity: entry.install.expectedIntegrity }
        : {}),
    });
  }

  return [...candidates.values()].toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
}

async function installCandidate(params: {
  candidate: DownloadableInstallCandidate;
  records: Record<string, PluginInstallRecord>;
}): Promise<{
  records: Record<string, PluginInstallRecord>;
  changes: string[];
  warnings: string[];
}> {
  const { candidate } = params;
  const warnings: string[] = [];
  if (candidate.clawhubSpec) {
    const result = await installPluginFromClawHub({
      spec: candidate.clawhubSpec,
      extensionsDir: resolveDefaultPluginExtensionsDir(),
      expectedPluginId: candidate.pluginId,
      mode: "install",
    });
    if (result.ok) {
      const pluginId = result.pluginId;
      return {
        records: {
          ...params.records,
          [pluginId]: {
            source: "clawhub",
            spec: candidate.clawhubSpec,
            installPath: result.targetDir,
            version: result.version,
            installedAt: new Date().toISOString(),
            integrity: result.clawhub.integrity,
            resolvedAt: result.clawhub.resolvedAt,
            clawhubUrl: result.clawhub.clawhubUrl,
            clawhubPackage: result.clawhub.clawhubPackage,
            clawhubFamily: result.clawhub.clawhubFamily,
            clawhubChannel: result.clawhub.clawhubChannel,
            clawpackSha256: result.clawhub.clawpackSha256,
            clawpackSpecVersion: result.clawhub.clawpackSpecVersion,
            clawpackManifestSha256: result.clawhub.clawpackManifestSha256,
            clawpackSize: result.clawhub.clawpackSize,
          },
        },
        changes: [
          `Installed missing configured plugin "${pluginId}" from ${candidate.clawhubSpec}.`,
        ],
        warnings: [],
      };
    }
    if (!candidate.npmSpec || !shouldFallbackClawHubCandidateToNpm(result)) {
      return {
        records: params.records,
        changes: [],
        warnings: [
          `Failed to install missing configured plugin "${candidate.pluginId}" from ${candidate.clawhubSpec}: ${result.error}`,
        ],
      };
    }
    warnings.push(
      `ClawHub ${candidate.clawhubSpec} unavailable for ${candidate.pluginId}; falling back to npm ${candidate.npmSpec}.`,
    );
  }
  if (!candidate.npmSpec) {
    return {
      records: params.records,
      changes: [],
      warnings: [
        `Failed to install missing configured plugin "${candidate.pluginId}": no supported install source found.`,
      ],
    };
  }
  const result = await installPluginFromNpmSpec({
    spec: candidate.npmSpec,
    extensionsDir: resolveDefaultPluginExtensionsDir(),
    expectedPluginId: candidate.pluginId,
    expectedIntegrity: candidate.expectedIntegrity,
    mode: "install",
  });
  if (!result.ok) {
    return {
      records: params.records,
      changes: [],
      warnings: [
        ...warnings,
        `Failed to install missing configured plugin "${candidate.pluginId}" from ${candidate.npmSpec}: ${result.error}`,
      ],
    };
  }
  const pluginId = result.pluginId;
  return {
    records: {
      ...params.records,
      [pluginId]: {
        source: "npm",
        spec: candidate.npmSpec,
        installPath: result.targetDir,
        version: result.version,
        installedAt: new Date().toISOString(),
        ...buildNpmResolutionInstallFields(result.npmResolution),
      },
    },
    changes: [`Installed missing configured plugin "${pluginId}" from ${candidate.npmSpec}.`],
    warnings,
  };
}

export async function repairMissingConfiguredPluginInstalls(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const knownIds = new Set(
    loadManifestMetadataSnapshot({
      config: params.cfg,
      env,
    }).plugins.map((plugin) => plugin.id),
  );
  const records = await loadInstalledPluginIndexInstallRecords({ env });
  const configuredPluginIds = collectConfiguredPluginIds(params.cfg);
  const missingRecordedPluginIds = Object.keys(records).filter(
    (pluginId) => configuredPluginIds.has(pluginId) && !knownIds.has(pluginId),
  );
  const changes: string[] = [];
  const warnings: string[] = [];
  let nextRecords = records;

  if (missingRecordedPluginIds.length > 0) {
    const updateResult = await updateNpmInstalledPlugins({
      config: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          installs: records,
        },
      },
      pluginIds: missingRecordedPluginIds,
      logger: {
        warn: (message) => warnings.push(message),
        error: (message) => warnings.push(message),
      },
    });
    for (const outcome of updateResult.outcomes) {
      if (outcome.status === "updated" || outcome.status === "unchanged") {
        changes.push(`Repaired missing configured plugin "${outcome.pluginId}".`);
      } else if (outcome.status === "error") {
        warnings.push(outcome.message);
      }
    }
    nextRecords = updateResult.config.plugins?.installs ?? nextRecords;
  }

  const missingPluginIds = new Set(
    [...configuredPluginIds].filter(
      (pluginId) => !knownIds.has(pluginId) && !Object.hasOwn(nextRecords, pluginId),
    ),
  );
  for (const candidate of collectDownloadableInstallCandidates({
    cfg: params.cfg,
    env,
    missingPluginIds,
  })) {
    if (knownIds.has(candidate.pluginId) || Object.hasOwn(nextRecords, candidate.pluginId)) {
      continue;
    }
    const installed = await installCandidate({ candidate, records: nextRecords });
    nextRecords = installed.records;
    changes.push(...installed.changes);
    warnings.push(...installed.warnings);
  }

  if (nextRecords !== records) {
    await writePersistedInstalledPluginIndexInstallRecords(nextRecords, { env });
  }
  return { changes, warnings };
}

export const __testing = {
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
  collectDownloadableInstallCandidates,
};
