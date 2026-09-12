// Owns managed plugin install, policy and uninstall mutations under the lifecycle lease.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginsReloadParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { collectChangedPaths } from "../config/config-change-paths.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentAcknowledgment,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import { normalizePluginId } from "./config-state.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import {
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "./install-config-mutation.js";
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import {
  capturePluginRuntimeApplications,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "./lifecycle.js";
import {
  type ManagedPluginCatalogEntry,
  loadOfficialCatalog,
  resolveOfficialEntryById,
} from "./management-catalog.js";
import { readPluginMutationSnapshot, readPluginRuntimeConfig } from "./management-config.js";
import type { ManagedPluginSourceInstallRequest } from "./management-install.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  loadFreshManagedPluginMetadata,
  refreshManagedPluginMetadata,
  listManagedPlugins,
} from "./management-service.js";
import { isBundledManifestOwner } from "./manifest-owner-policy.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginInstallSources,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";

type ManagedPluginMutationOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  applyRuntime?: PluginLifecycleRuntimeApply;
  beforePersistentApply?: () => void;
};

function withManagedPluginMutation<T>(
  params: ManagedPluginMutationOptions,
  run: (beforePersistentApply: () => void) => Promise<T>,
): Promise<T> {
  return withPluginLifecycleLease(
    { env: params.env ?? process.env, signal: params.signal },
    (lease) => {
      const beforePersistentApply = () => {
        params.signal?.throwIfAborted();
        lease.assertOwned();
        params.beforePersistentApply?.();
      };
      beforePersistentApply();
      return run(beforePersistentApply);
    },
  );
}

type ManagedPluginInstallRequest =
  | {
      source: "clawhub";
      packageName: string;
      version?: string;
      acknowledgeInstallPolicyWarning?: true;
      acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    }
  | {
      source: "official";
      pluginId: string;
      acknowledgeInstallPolicyWarning?: true;
      acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    };

function createSilentRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new ManagedPluginLifecycleError(`plugin lifecycle exited with code ${code}`);
    },
  };
}

function createInstallLogger(warnings: string[]) {
  return {
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
  };
}

/** Explicitly declared runtime id, ignoring the entry-id fallback used for display. */
function resolveDeclaredOfficialPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  // Bundled identities remain the local trust anchor when a hosted feed omits
  // its ClawHub candidate; hosted install/version metadata is never copied back.
  return [...listOfficialExternalPluginCatalogEntries(), ...entries].find((entry) => {
    return resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    );
  });
}

function resolveHostedOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => {
    return resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    );
  });
}

function buildClawHubSpec(packageName: string, version?: string): string {
  const parsed = parseClawHubPluginSpec(`clawhub:${packageName}`);
  if (!parsed || parsed.version) {
    throw new ManagedPluginLifecycleError(`invalid ClawHub package name: ${packageName}`);
  }
  return `clawhub:${packageName}${version ? `@${version}` : ""}`;
}

function throwInstallFailure(result: {
  error: string;
  code?: string;
  version?: string;
  warning?: string;
  installPolicyWarning?: InstallPolicyWarningDetails;
}): never {
  const unavailable =
    !result.code ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE;
  throw new ManagedPluginLifecycleError(result.error, {
    kind: unavailable ? "unavailable" : "invalid-request",
    code: result.code,
    version: result.version,
    warning: result.warning,
    installPolicyWarning: result.installPolicyWarning,
    cause: result,
  });
}

function resolveManagedClawHubInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "clawhub" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  expectedIntegrity?: string;
}): Extract<ManagedPluginSourceInstallRequest, { source: "clawhub" }> {
  const packageName = params.request.packageName.trim();
  const official = resolveOfficialEntryByClawHubPackage(params.officialEntries, packageName);
  // Pin the runtime id only when the catalog entry declares one; the entry-id
  // fallback is just the package name and would reject legitimate installs.
  const expectedPluginId = official ? resolveDeclaredOfficialPluginId(official) : undefined;
  const hostedOfficial = resolveHostedOfficialEntryByClawHubPackage(
    params.officialEntries,
    packageName,
  );
  const hostedSource = hostedOfficial
    ? resolveOfficialExternalPluginInstallSources(hostedOfficial).find(
        (source) => source.source === "clawhub",
      )
    : undefined;
  const hostedClawHub = parseClawHubPluginSpec(hostedSource?.spec ?? "");
  const requestMatchesHostedCandidate =
    !params.request.version || params.request.version === hostedClawHub?.version;
  const version =
    params.request.version ?? (requestMatchesHostedCandidate ? hostedClawHub?.version : undefined);
  const expectedIntegrity =
    params.expectedIntegrity ??
    (requestMatchesHostedCandidate ? hostedSource?.expectedIntegrity : undefined);
  return {
    source: "clawhub",
    spec: buildClawHubSpec(packageName, version),
    ...(official ? { trustedSourceLinkedOfficialInstall: true } : {}),
    ...(expectedPluginId ? { expectedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
  };
}

function resolveManagedOfficialInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "official" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): ManagedPluginSourceInstallRequest {
  const entry = resolveOfficialEntryById(params.officialEntries, params.request.pluginId);
  if (!entry) {
    throw new ManagedPluginLifecycleError(
      `unknown official plugin catalog entry: ${params.request.pluginId}`,
    );
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  const install = resolveOfficialExternalPluginInstall(entry);
  if (!pluginId || !install) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry is not installable: ${params.request.pluginId}`,
    );
  }
  const installSources = resolveOfficialExternalPluginInstallSources(entry);
  const primary = installSources[0];
  if (!primary) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry has no supported install source: ${params.request.pluginId}`,
    );
  }
  return {
    source: "official",
    spec: primary.spec,
    installSources,
    pluginId,
    expectedPluginId: resolveDeclaredOfficialPluginId(entry),
    mode: "install",
  };
}

/** Install a ClawHub or curated official plugin through the canonical install pipeline. */
export async function installManagedPlugin(
  params: ManagedPluginMutationOptions & {
    request: ManagedPluginInstallRequest;
  },
): Promise<{
  plugin: ManagedPluginCatalogEntry;
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const { installManagedPluginSource } = await import("./management-install.js");
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const snapshot = await readPluginMutationSnapshot(env, beforePersistentApply);
    const officialCatalog = await loadOfficialCatalog();
    const warnings: string[] = [];
    const installLogger = createInstallLogger(warnings);
    const request =
      params.request.source === "clawhub"
        ? resolveManagedClawHubInstallRequest({
            request: params.request,
            officialEntries: officialCatalog.entries,
          })
        : resolveManagedOfficialInstallRequest({
            request: params.request,
            officialEntries: officialCatalog.entries,
          });
    const captured = params.applyRuntime
      ? capturePluginRuntimeApplications(params.applyRuntime)
      : undefined;
    const installed = await installManagedPluginSource({
      applyRuntime: captured?.applyRuntime,
      beforePersistentApply,
      request,
      snapshot,
      env,
      logger: installLogger,
      ...(params.request.acknowledgeCapabilities
        ? { acknowledgeCapabilities: params.request.acknowledgeCapabilities }
        : {}),
      ...(params.request.acknowledgeInstallPolicyWarning
        ? {
            safetyOverrides: {
              onInstallPolicyWarning: async () => ({ status: "approved" as const }),
            },
          }
        : {}),
      invalidateRuntimeCache: false,
      runtime: createSilentRuntime(),
    });
    if (!installed.ok) {
      return throwInstallFailure(installed);
    }
    warnings.push(...(installed.warnings ?? []));
    const workspace = resolvePluginControlPlaneWorkspace({ config: installed.config, env });
    if (workspace.diagnostic && !getProcessGatewayPluginMetadataSnapshot()) {
      warnings.push(workspace.diagnostic.message);
    }
    // Management inspects the committed candidate; the Gateway keeps its boot inventory.
    const installedMetadata = refreshManagedPluginMetadata({ config: installed.config, env });
    const catalog = await listManagedPlugins({
      config: installed.config,
      env,
      officialCatalog,
      metadata: installedMetadata,
    });
    const installedOwnership = createInstalledPluginOwnershipResolver(
      installedMetadata.index,
      env,
    ).resolvePackage(installed.pluginId);
    if (!installedOwnership.ok) {
      throw new ManagedPluginLifecycleError(installedOwnership.error);
    }
    const installedPluginIds = installedOwnership.value.pluginIds;
    const representativePluginId = installedPluginIds[0]!;
    const plugin = catalog.plugins.find((entry) => entry.id === representativePluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `installed plugin missing from refreshed registry: ${installed.pluginId}`,
      );
    }
    return {
      plugin,
      ...(captured?.application ? { application: captured.application } : {}),
      ...(installedPluginIds.length > 1 || warnings.length > 0
        ? {
            warnings: [
              ...(installedPluginIds.length > 1
                ? [
                    `Installed package "${installed.pluginId}" with plugin entries: ${installedPluginIds.join(", ")}.`,
                  ]
                : []),
              ...new Set(warnings),
            ],
          }
        : {}),
    };
  });
}

type ManagedPluginEnableRequest = ManagedPluginMutationOptions & {
  allowlistPolicy?: "preserve";
  pluginId: string;
  enabled: boolean;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
};

/** Commit plugin policy without requiring the management catalog's hosted projection. */
export async function mutateManagedPluginEnabled(
  params: ManagedPluginEnableRequest & {
    caller: "cli" | "management";
    onCapabilityConsent?: PluginCapabilityConsentHandler;
    requestCapabilityConsent?: boolean;
  },
) {
  const env = params.env ?? process.env;
  const cli = params.caller === "cli";
  const preserveAllowlist = cli || params.allowlistPolicy === "preserve";
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    if (cli) {
      assertConfigWriteAllowedInCurrentMode({ env });
    }
    // CLI policy writes retain their config owner's include admission. Management
    // additionally requires the install mutation preflight before any consent.
    const snapshot: ConfigSnapshotForInstallPersist = cli
      ? await readConfigFileSnapshotForWrite().then(({ snapshot: file, writeOptions }) => ({
          config: file.sourceConfig,
          baseHash: file.hash,
          writeOptions: selectInstallMutationWriteOptions(writeOptions),
        }))
      : await readPluginMutationSnapshot(env, beforePersistentApply);
    const metadata = loadFreshManagedPluginMetadata(snapshot.config, env);
    const pluginId = cli
      ? normalizePluginId(params.pluginId)
      : metadata.normalizePluginId(params.pluginId.trim());
    const installedPlugin = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (!installedPlugin) {
      return { status: "missing" as const, pluginId };
    }
    const resolveConsent = async () => {
      if (
        params.enabled &&
        (params.applyRuntime ||
          !installedPlugin.enabled ||
          params.requestCapabilityConsent ||
          params.acknowledgeCapabilities)
      ) {
        await resolvePluginCapabilityConsent({
          config: snapshot.config,
          env,
          pluginId,
          acknowledge: params.acknowledgeCapabilities,
          onCapabilityConsent: params.onCapabilityConsent,
          beforePersistentApply,
          metadata,
        });
      }
    };
    if (!preserveAllowlist) {
      await resolveConsent();
    }
    let next = snapshot.config;
    const slotWarnings: string[] = [];
    let policyPluginId = pluginId;
    if (params.enabled) {
      // Admin selection admits one installed plugin; CLI preserves restrictive policy.
      if (!preserveAllowlist && (next.plugins?.allow?.length ?? 0) > 0) {
        next = ensurePluginAllowlisted(next, pluginId);
      }
      const enableResult = enableExplicitlySelectedPluginInConfig(next, pluginId, {
        updateChannelConfig: false,
      });
      if (!enableResult.enabled) {
        return { status: "blocked" as const, pluginId, reason: enableResult.reason };
      }
      // CLI rejection precedes consent; reuse this exact config after review.
      if (preserveAllowlist) {
        await resolveConsent();
      }
      next = enableResult.config;
      policyPluginId = enableResult.pluginId;
      // Bundled kinds are already prepared under this lease. External CLI inspection
      // still needs the enabled config to resolve legacy runtime-only kinds.
      const slotMetadata = cli && !isBundledManifestOwner(installedPlugin) ? undefined : metadata;
      beforePersistentApply();
      const slotResult = await applySlotSelectionForPlugin(
        next,
        pluginId,
        slotMetadata,
        beforePersistentApply,
      );
      next = slotResult.config;
      slotWarnings.push(...slotResult.warnings);
    } else {
      next = setPluginEnabledInConfig(next, pluginId, false, { updateChannelConfig: false });
    }
    const changedPaths = new Set<string>();
    collectChangedPaths(snapshot.config, next, "", changedPaths);
    const write = await replaceConfigFile({
      sourceConfig: next,
      baseHash: snapshot.baseHash,
      // CLI alias writes preserve merged canonical settings during source projection.
      writeOptions: {
        ...snapshot.writeOptions,
        assertConfigPathForWrite: () => {
          snapshot.writeOptions.assertConfigPathForWrite?.();
          beforePersistentApply();
        },
        ...(cli || params.applyRuntime
          ? { explicitSetPaths: [["plugins", "entries", policyPluginId]] }
          : {}),
        ...(params.applyRuntime
          ? { afterWrite: { mode: "none" as const, reason: "plugin lifecycle applies runtime" } }
          : {}),
      },
    });
    const registryWarnings: string[] = [];
    await refreshPluginRegistryAfterConfigMutation({
      configPath: write.path,
      env,
      reason: "policy-changed",
      invalidateRuntimeCache: false,
      policyPluginIds: [policyPluginId],
      logger: { warn: (message) => registryWarnings.push(message) },
    });
    return {
      write,
      policyPluginId,
      status: "committed" as const,
      pluginId,
      config: next,
      changedPaths: [...changedPaths].filter(Boolean).toSorted(),
      warnings: cli
        ? [...registryWarnings, ...slotWarnings]
        : [...slotWarnings, ...registryWarnings],
    };
  });
}

/** Persist desired policy and project the committed candidate into the management catalog. */
export async function setManagedPluginEnabled(params: ManagedPluginEnableRequest): Promise<{
  plugin: ManagedPluginCatalogEntry;
  changedPaths: string[];
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const result = await mutateManagedPluginEnabled({ ...params, caller: "management" });
    if (result.status !== "committed") {
      throw new ManagedPluginLifecycleError(
        result.status === "missing"
          ? `plugin not installed: ${params.pluginId}`
          : `plugin "${result.pluginId}" could not be enabled (${result.reason ?? "unknown reason"})`,
      );
    }
    const metadata = refreshManagedPluginMetadata({ config: result.config, env });
    const application = await params.applyRuntime?.({
      config: result.config,
      write: result.write,
      pluginIds: [result.policyPluginId],
      reason: params.enabled ? "enable" : "disable",
      assertInvokerOwned: beforePersistentApply,
    });
    const catalog = await listManagedPlugins({ config: result.config, env, metadata });
    const plugin = catalog.plugins.find((entry) => entry.id === result.pluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `updated plugin missing from refreshed registry: ${result.pluginId}`,
      );
    }
    return {
      plugin,
      changedPaths: result.changedPaths,
      ...(application ? { application } : {}),
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  });
}

/** Reload the selected installed package through the running Gateway's lifecycle owner. */
export async function reloadManagedPlugin(
  params: ManagedPluginMutationOptions &
    PluginsReloadParams & {
      applyRuntime: PluginLifecycleRuntimeApply;
    },
) {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const config = await readPluginRuntimeConfig();
    const metadata = loadFreshManagedPluginMetadata(config, env);
    const targets = params.plugins;
    const hasInstallPreconditions = targets.some((target) => target.installHash !== undefined);
    const resolveTargets = () => {
      beforePersistentApply();
      // Consent can rewrite accepted-surface facts under this lease. Its writer
      // invalidates the ledger cache; captured metadata cannot validate a later hash.
      const records = hasInstallPreconditions
        ? readPersistedInstalledPluginIndexInstallRecords({ env })
        : undefined;
      const resolver = createInstalledPluginOwnershipResolver(metadata.index, env);
      return targets.map((target) => {
        const pluginId = metadata.normalizePluginId(target.pluginId.trim());
        const ownership = resolver.resolveReload(pluginId);
        if (!ownership.ok || ownership.value.kind === "orphan") {
          throw new ManagedPluginLifecycleError(
            ownership.ok ? `plugin not installed: ${pluginId}` : ownership.error,
          );
        }
        const ownedPluginIds = ownership.value.pluginIds;
        let install: { id: string; hash: string } | undefined;
        if (target.installHash !== undefined) {
          const owner = ownership.value.installOwner;
          if (
            !owner ||
            !records?.[owner] ||
            hashStableJson(records[owner]) !== target.installHash
          ) {
            throw new ManagedPluginLifecycleError(
              `Plugin ${pluginId} changed after the installation batch. Inspect it before reloading.`,
            );
          }
          install = { id: owner, hash: target.installHash };
        }
        const sourceDigests = target.sourceDigests ?? {};
        if (Object.keys(sourceDigests).some((id) => !ownedPluginIds.includes(id))) {
          throw new ManagedPluginLifecycleError(
            `Source expectations for ${pluginId} include a different package owner`,
          );
        }
        return {
          pluginId,
          pluginIds: ownedPluginIds,
          sourceDigests,
          install,
        };
      });
    };
    for (const pluginId of new Set(resolveTargets().flatMap((target) => target.pluginIds))) {
      await resolvePluginCapabilityConsent({
        config,
        env,
        pluginId,
        metadata,
        acknowledge: params.acknowledgeCapabilities,
        beforePersistentApply,
      });
    }
    const resolved = resolveTargets();
    const pluginIds = [...new Set(resolved.flatMap((target) => target.pluginIds))].toSorted();
    const expected = new Map<string, string>();
    for (const target of resolved) {
      for (const [id, digest] of Object.entries(target.sourceDigests)) {
        if (expected.has(id) && expected.get(id) !== digest) {
          throw new ManagedPluginLifecycleError(`Conflicting source expectations for ${id}`);
        }
        expected.set(id, digest);
      }
    }
    return {
      pluginIds: resolved.map((target) => target.pluginId),
      application: await params.applyRuntime({
        config,
        pluginIds,
        reason: "reload",
        ...(expected.size ? { expectedSourceDigests: Object.fromEntries(expected) } : {}),
        ...(resolved.every((target) => target.install !== undefined)
          ? {
              expectedInstallHashes: Object.fromEntries(
                resolved.flatMap(({ install }) => (install ? [[install.id, install.hash]] : [])),
              ),
            }
          : {}),
        assertInvokerOwned: beforePersistentApply,
      }),
    };
  });
}

/** Apply an explicit metadata refresh under the same cross-process lifecycle lease. */
export async function refreshManagedPlugins(
  params: ManagedPluginMutationOptions & {
    applyRuntime: PluginLifecycleRuntimeApply;
  },
): Promise<{ application: PluginRuntimeApplication }> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const snapshot = await readPluginMutationSnapshot(env, beforePersistentApply);
    refreshManagedPluginMetadata({ config: snapshot.config, env });
    return {
      application: await params.applyRuntime({
        config: snapshot.config,
        pluginIds: [],
        reason: "metadata",
        assertInvokerOwned: beforePersistentApply,
      }),
    };
  });
}
