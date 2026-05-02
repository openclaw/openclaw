import { listChannelPluginCatalogEntries } from "../../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import { buildClawHubPluginInstallRecordFields } from "../../../plugins/clawhub-install-records.js";
import { CLAWHUB_INSTALL_ERROR_CODE, installPluginFromClawHub } from "../../../plugins/clawhub.js";
import { resolveDefaultPluginExtensionsDir } from "../../../plugins/install-paths.js";
import { installPluginFromNpmSpec } from "../../../plugins/install.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields } from "../../../plugins/installs.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../../../plugins/official-external-plugin-catalog.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { updateNpmInstalledPlugins } from "../../../plugins/update.js";
import { asObjectRecord } from "./object.js";

type DownloadableInstallCandidate = {
  pluginId: string;
  label: string;
  npmSpec?: string;
  clawhubSpec?: string;
  expectedIntegrity?: string;
  defaultChoice?: PluginPackageInstall["defaultChoice"];
};

const RUNTIME_PLUGIN_INSTALL_CANDIDATES: readonly DownloadableInstallCandidate[] = [
  // Runtime-only configs do not have a provider/channel integration catalog entry.
  {
    pluginId: "codex",
    label: "Codex",
    npmSpec: "@openclaw/codex@beta",
  },
];

function buildOpenClawClawHubSpec(npmSpec: string): string | undefined {
  const parsed = parseRegistryNpmSpec(npmSpec);
  if (!parsed?.name.startsWith("@openclaw/")) {
    return undefined;
  }
  return `clawhub:${parsed.name}${parsed.selector ? `@${parsed.selector}` : ""}`;
}

function shouldFallbackClawHubToNpm(result: { ok: false; code?: string }): boolean {
  return (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND
  );
}

function normalizeInstallDefaultChoice(
  value: PluginPackageInstall["defaultChoice"] | undefined,
): PluginPackageInstall["defaultChoice"] | undefined {
  return value === "clawhub" || value === "npm" || value === "local" ? value : undefined;
}

function resolveCandidateClawHubSpec(install: PluginPackageInstall): string | undefined {
  const explicit = install.clawhubSpec?.trim();
  if (explicit) {
    return explicit;
  }
  const npmSpec = install.npmSpec?.trim();
  if (!npmSpec || normalizeInstallDefaultChoice(install.defaultChoice) === "npm") {
    return undefined;
  }
  return buildOpenClawClawHubSpec(npmSpec);
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
  configuredPluginIds?: ReadonlySet<string>;
  configuredChannelIds?: ReadonlySet<string>;
  blockedPluginIds?: ReadonlySet<string>;
}): DownloadableInstallCandidate[] {
  const configuredPluginIds = params.configuredPluginIds ?? collectConfiguredPluginIds(params.cfg);
  const configuredChannelIds =
    params.configuredChannelIds ?? collectConfiguredChannelIds(params.cfg);
  const candidates = new Map<string, DownloadableInstallCandidate>();

  for (const entry of listChannelPluginCatalogEntries({
    env: params.env,
    excludeWorkspace: true,
  })) {
    const pluginId = entry.pluginId ?? entry.id;
    if (params.blockedPluginIds?.has(pluginId)) {
      continue;
    }
    if (
      !params.missingPluginIds.has(pluginId) &&
      !configuredPluginIds.has(pluginId) &&
      !configuredChannelIds.has(entry.id)
    ) {
      continue;
    }
    const npmSpec = entry.install.npmSpec?.trim();
    const clawhubSpec = resolveCandidateClawHubSpec(entry.install);
    if (!npmSpec && !clawhubSpec) {
      continue;
    }
    candidates.set(pluginId, {
      pluginId,
      label: entry.meta.label,
      ...(npmSpec ? { npmSpec } : {}),
      ...(clawhubSpec ? { clawhubSpec } : {}),
      ...(entry.install.expectedIntegrity
        ? { expectedIntegrity: entry.install.expectedIntegrity }
        : {}),
      ...(entry.install.defaultChoice ? { defaultChoice: entry.install.defaultChoice } : {}),
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
    if (params.blockedPluginIds?.has(entry.pluginId)) {
      continue;
    }
    const npmSpec = entry.install.npmSpec?.trim();
    const clawhubSpec = resolveCandidateClawHubSpec(entry.install);
    if (!npmSpec && !clawhubSpec) {
      continue;
    }
    candidates.set(entry.pluginId, {
      pluginId: entry.pluginId,
      label: entry.label,
      ...(npmSpec ? { npmSpec } : {}),
      ...(clawhubSpec ? { clawhubSpec } : {}),
      ...(entry.install.expectedIntegrity
        ? { expectedIntegrity: entry.install.expectedIntegrity }
        : {}),
      ...(entry.install.defaultChoice ? { defaultChoice: entry.install.defaultChoice } : {}),
    });
  }

  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    if (!pluginId || candidates.has(pluginId) || params.blockedPluginIds?.has(pluginId)) {
      continue;
    }
    if (!configuredPluginIds.has(pluginId) && !params.missingPluginIds.has(pluginId)) {
      continue;
    }
    const install = resolveOfficialExternalPluginInstall(entry);
    if (!install) {
      continue;
    }
    const npmSpec = install.npmSpec?.trim();
    const clawhubSpec = resolveCandidateClawHubSpec(install);
    if (!npmSpec && !clawhubSpec) {
      continue;
    }
    candidates.set(pluginId, {
      pluginId,
      label: resolveOfficialExternalPluginLabel(entry),
      ...(npmSpec ? { npmSpec } : {}),
      ...(clawhubSpec ? { clawhubSpec } : {}),
      ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
      ...(install.defaultChoice ? { defaultChoice: install.defaultChoice } : {}),
    });
  }

  for (const entry of RUNTIME_PLUGIN_INSTALL_CANDIDATES) {
    if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) {
      continue;
    }
    if (params.blockedPluginIds?.has(entry.pluginId)) {
      continue;
    }
    candidates.set(entry.pluginId, entry);
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
  const extensionsDir = resolveDefaultPluginExtensionsDir();
  const changes: string[] = [];
  if (candidate.clawhubSpec && candidate.defaultChoice !== "npm") {
    const clawhubResult = await installPluginFromClawHub({
      spec: candidate.clawhubSpec,
      extensionsDir,
      expectedPluginId: candidate.pluginId,
      mode: "install",
    });
    if (clawhubResult.ok) {
      const pluginId = clawhubResult.pluginId;
      return {
        records: {
          ...params.records,
          [pluginId]: {
            ...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
            spec: candidate.clawhubSpec,
            installPath: clawhubResult.targetDir,
            installedAt: new Date().toISOString(),
          },
        },
        changes: [
          `Installed missing configured plugin "${pluginId}" from ${candidate.clawhubSpec}.`,
        ],
        warnings: [],
      };
    }
    if (!candidate.npmSpec || !shouldFallbackClawHubToNpm(clawhubResult)) {
      return {
        records: params.records,
        changes: [],
        warnings: [
          `Failed to install missing configured plugin "${candidate.pluginId}" from ${candidate.clawhubSpec}: ${clawhubResult.error}`,
        ],
      };
    }
    changes.push(
      `ClawHub ${candidate.clawhubSpec} unavailable for "${candidate.pluginId}"; falling back to npm ${candidate.npmSpec}.`,
    );
  }
  if (!candidate.npmSpec) {
    return {
      records: params.records,
      changes: [],
      warnings: [
        `Failed to install missing configured plugin "${candidate.pluginId}": missing npm spec.`,
      ],
    };
  }
  const result = await installPluginFromNpmSpec({
    spec: candidate.npmSpec,
    extensionsDir,
    expectedPluginId: candidate.pluginId,
    expectedIntegrity: candidate.expectedIntegrity,
    mode: "install",
  });
  if (!result.ok) {
    return {
      records: params.records,
      changes: [],
      warnings: [
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
    changes: [
      ...changes,
      `Installed missing configured plugin "${pluginId}" from ${candidate.npmSpec}.`,
    ],
    warnings: [],
  };
}

export async function repairMissingConfiguredPluginInstalls(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  return repairMissingPluginInstalls({
    cfg: params.cfg,
    env: params.env,
    pluginIds: collectConfiguredPluginIds(params.cfg),
    channelIds: collectConfiguredChannelIds(params.cfg),
  });
}

export async function repairMissingPluginInstallsForIds(params: {
  cfg: OpenClawConfig;
  pluginIds: Iterable<string>;
  channelIds?: Iterable<string>;
  blockedPluginIds?: Iterable<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  return repairMissingPluginInstalls({
    cfg: params.cfg,
    env: params.env,
    pluginIds: new Set(
      [...params.pluginIds].map((pluginId) => pluginId.trim()).filter((pluginId) => pluginId),
    ),
    channelIds: new Set(
      [...(params.channelIds ?? [])]
        .map((channelId) => channelId.trim())
        .filter((channelId) => channelId),
    ),
    blockedPluginIds: new Set(
      [...(params.blockedPluginIds ?? [])]
        .map((pluginId) => pluginId.trim())
        .filter((pluginId) => pluginId),
    ),
  });
}

async function repairMissingPluginInstalls(params: {
  cfg: OpenClawConfig;
  pluginIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
  blockedPluginIds?: ReadonlySet<string>;
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
  const missingRecordedPluginIds = Object.keys(records).filter(
    (pluginId) => params.pluginIds.has(pluginId) && !knownIds.has(pluginId),
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
    [...params.pluginIds].filter(
      (pluginId) => !knownIds.has(pluginId) && !Object.hasOwn(nextRecords, pluginId),
    ),
  );
  for (const candidate of collectDownloadableInstallCandidates({
    cfg: params.cfg,
    env,
    missingPluginIds,
    configuredPluginIds: params.pluginIds,
    configuredChannelIds: params.channelIds,
    blockedPluginIds: params.blockedPluginIds,
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
  buildOpenClawClawHubSpec,
};
