// Owns managed plugin install, policy and uninstall mutations under the lifecycle lease.
import type {
  PluginsInstallParams,
  PluginsReloadParams,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { collectChangedPaths } from "../config/config-change-paths.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import { reportClawHubPluginInstallTelemetry } from "../infra/clawhub-packages.js";
import { formatErrorMessage } from "../infra/errors.js";
import { markClawPackageIndependentlyOwned } from "../state/claw-package-adoption.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { shortenHomePath } from "../utils.js";
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
import {
  loadConfigForInstall,
  PluginInstallConfigError,
  resolvePluginInstallRequestContext,
} from "./install-config.js";
import { resolveManagedPluginInstallRequest } from "./install-source-plan.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import {
  capturePluginRuntimeApplications,
  PluginInstallPersistedError,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "./lifecycle.js";
import { type ManagedPluginCatalogEntry, loadOfficialCatalog } from "./management-catalog.js";
import { readPluginMutationSnapshot, readPluginRuntimeConfig } from "./management-config.js";
import type {
  ManagedPluginInstallOptions,
  installManagedPluginSource,
} from "./management-install.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  loadFreshManagedPluginMetadata,
  refreshManagedPluginMetadata,
  listManagedPlugins,
} from "./management-service.js";
import { isBundledManifestOwner } from "./manifest-owner-policy.js";
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

function throwInstallFailure(
  result: Omit<
    Extract<Awaited<ReturnType<typeof installManagedPluginSource>>, { ok: false }>,
    "ok"
  >,
): never {
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
    installRejected: true,
    installSource: result.installSource,
  });
}

/** Install a ClawHub or curated official plugin through the canonical install pipeline. */
export async function installManagedPlugin(
  params: ManagedPluginInstallOptions & {
    request: PluginsInstallParams;
  },
): Promise<{
  plugin: ManagedPluginCatalogEntry;
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  try {
    assertConfigWriteAllowedInCurrentMode({ env: params.env });
  } catch (error) {
    throw new ManagedPluginLifecycleError(formatErrorMessage(error), { cause: error });
  }
  const { installManagedPluginSource } = await import("./management-install.js");
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const performInstall = async () => {
      const officialCatalog =
        params.request.source === "official" || params.request.source === "clawhub"
          ? await loadOfficialCatalog()
          : { entries: [] };
      const warnings: string[] = [];
      const request = resolveManagedPluginInstallRequest(params.request, officialCatalog.entries);
      const planned = resolvePluginInstallRequestContext({
        source: request.source,
        rawSpec:
          request.source === "local"
            ? request.path
            : request.source === "npm-pack"
              ? `npm-pack:${request.archivePath}`
              : request.source === "bundled"
                ? request.bundledSource.localPath
                : request.source === "marketplace"
                  ? request.plugin
                  : request.spec,
        ...(request.source === "marketplace" ? { marketplace: request.marketplace } : {}),
        installKind: "plugin",
      });
      if (!planned.ok) {
        throw new ManagedPluginLifecycleError(planned.error);
      }
      const snapshot =
        params.snapshot ??
        (await loadConfigForInstall(planned.request).catch((error: unknown) => {
          if (!(error instanceof PluginInstallConfigError)) {
            throw error;
          }
          throw new ManagedPluginLifecycleError(error.message, {
            code: PLUGIN_INSTALL_ERROR_CODE.CONFIG_MUTATION_BLOCKED,
            installRejected: true,
            ...(request.source === "official" && request.installSources?.[0]
              ? { installSource: request.installSources[0] }
              : {}),
            cause: error,
          });
        }));
      beforePersistentApply();
      if (request.source === "local" && request.link) {
        request.successMessage = `Linked plugin path: ${shortenHomePath(request.path)}`;
      }
      if (request.source === "clawhub" && params.confirmInstall) {
        request.confirmInstall = params.confirmInstall;
      }
      const captured = params.applyRuntime
        ? capturePluginRuntimeApplications(params.applyRuntime)
        : undefined;
      const installed = await installManagedPluginSource({
        applyRuntime: captured?.applyRuntime,
        deferRuntime: params.deferRuntime,
        beforePersistentApply,
        request,
        snapshot,
        env,
        logger: params.logger ?? { warn: (message) => warnings.push(message) },
        onCapabilityConsent: params.onCapabilityConsent,
        beforePersistentEffect: params.beforePersistentEffect,
        ...(params.request.acknowledgeCapabilities
          ? { acknowledgeCapabilities: params.request.acknowledgeCapabilities }
          : {}),
        ...(params.request.acknowledgeInstallPolicyWarning
          ? {
              safetyOverrides: {
                onInstallPolicyWarning: async () => ({ status: "approved" as const }),
              },
            }
          : params.safetyOverrides
            ? { safetyOverrides: params.safetyOverrides }
            : {}),
        invalidateRuntimeCache: params.invalidateRuntimeCache ?? false,
        runtime: { log: () => {} },
      });
      if (!installed.ok) {
        return throwInstallFailure(installed);
      }
      try {
        warnings.push(...(installed.warnings ?? []));
        if (params.request.source === "clawhub" && installed.clawhub) {
          if (!params.clawManaged && installed.clawhub.version) {
            markClawPackageIndependentlyOwned({
              kind: "plugin",
              source: "clawhub",
              ref: installed.clawhub.clawhubPackage,
              version: installed.clawhub.version,
            });
          }
          await reportClawHubPluginInstallTelemetry({
            baseUrl: installed.clawhub.clawhubUrl,
            packageName: installed.clawhub.clawhubPackage,
            version: installed.clawhub.version,
          }).catch(() => undefined);
        }
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
      } catch (error) {
        throw new PluginInstallPersistedError(installed.pluginId, error);
      }
    };
    return params.request.source === "clawhub" && !params.clawManaged
      ? await withClawPackageLifecycleLease(
          { kind: "plugin", source: "clawhub", ref: params.request.packageName },
          performInstall,
        )
      : await performInstall();
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
