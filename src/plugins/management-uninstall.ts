// Plans and commits package-owned uninstall state for CLI and management callers.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { ok, err, type Result } from "@openclaw/normalization-core/result";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { createConfigIO } from "../config/io.factory.js";
import { transformConfigFileWithRetry } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConfigWriteLock } from "../config/write-lock.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { shortenHomePath } from "../utils.js";
import {
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "./install-config-mutation.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import type { PluginInstallRuntimeDeferral } from "./install-runtime-batch.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { createInstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import {
  capturePluginRuntimeApplications,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "./lifecycle.js";
import { readPluginMutationSnapshot } from "./management-config.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  loadFreshManagedPluginMetadata,
  refreshManagedPluginMetadata,
} from "./management-service.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "./plugin-lifecycle-trace.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { withPluginSourceCleanup } from "./source-cleanup.js";
import { buildPluginSnapshotReport } from "./status.js";
import { collectClawPluginUninstallWarnings } from "./uninstall-claw-references.js";
import {
  prepareConfigForDisabledPluginSet,
  recordPluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";
import { resolvePluginUninstallId } from "./uninstall-selection.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  planPluginUninstall,
  pluginUninstallTargetExists,
} from "./uninstall.js";

type UninstallRequest = { pluginId: string; env?: NodeJS.ProcessEnv; keepFiles?: boolean };
type UninstallPolicy = UninstallRequest & { caller: "cli" | "management" };
export type PreparedPluginUninstall = {
  snapshot: ConfigSnapshotForInstallPersist;
  installRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  pluginId: string;
  requestedPluginId: string;
  pluginIds: string[];
  policyPluginIds: string[];
  name: string;
  channelIds: string[] | undefined;
  plan: Extract<ReturnType<typeof planPluginUninstall>, { ok: true }>;
  planForConfig: (config: OpenClawConfig) => ReturnType<typeof planPluginUninstall>;
};

type PluginUninstallOutcome = Pick<
  PreparedPluginUninstall,
  "pluginId" | "requestedPluginId" | "pluginIds"
> & {
  removed: string[];
  warnings: string[];
  application?: PluginRuntimeApplication;
};

function runUninstallPhase<T>(
  params: UninstallPolicy,
  phase: string,
  run: () => Promise<T>,
): Promise<T> {
  return params.caller === "cli"
    ? tracePluginLifecyclePhaseAsync(phase, run, { command: "uninstall" })
    : run();
}

async function readUninstallSnapshot(
  params: UninstallPolicy,
  phase: string,
): Promise<ConfigSnapshotForInstallPersist> {
  return await runUninstallPhase(params, phase, async () => {
    if (params.caller === "management") {
      return await readPluginMutationSnapshot(params.env ?? process.env);
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    return {
      config: snapshot.sourceConfig,
      baseHash: snapshot.hash,
      writeOptions: selectInstallMutationWriteOptions(writeOptions),
    };
  });
}

/** Read-only plan; execution always replans under its lease after confirmation. */
export async function preparePluginUninstall(
  params: UninstallPolicy,
): Promise<Result<PreparedPluginUninstall, string>> {
  const env = params.env ?? process.env;
  const cli = params.caller === "cli";
  const snapshot = await readUninstallSnapshot(params, "config read");
  const installRecords = await runUninstallPhase(params, "install records load", () =>
    loadInstalledPluginIndexInstallRecords(cli ? {} : { env }),
  );
  const config = withPluginInstallRecords(snapshot.config, installRecords);
  // CLI selection uses its status projection; management retains its broader metadata aliases.
  const metadata = cli ? undefined : loadFreshManagedPluginMetadata(config, env);
  const index = metadata?.index ?? loadInstalledPluginIndex({ config, installRecords });
  const plugins = metadata
    ? metadata.index.plugins.map((record) => {
        const manifest = metadata.byPluginId.get(record.pluginId);
        return {
          id: record.pluginId,
          name: manifest?.name ?? record.pluginId,
          origin: record.origin,
          source: manifest?.source,
          channelIds: manifest?.channels,
        };
      })
    : tracePluginLifecyclePhase(
        "plugin registry snapshot",
        () => buildPluginSnapshotReport({ config }),
        { command: "uninstall" },
      ).plugins;
  const requestedId = metadata
    ? metadata.normalizePluginId(params.pluginId.trim())
    : params.pluginId;
  const selection: Result<{ pluginId: string; plugin?: (typeof plugins)[number] }, string> = cli
    ? resolvePluginUninstallId({ rawId: requestedId, config, plugins })
    : ok({ pluginId: requestedId, plugin: plugins.find((plugin) => plugin.id === requestedId) });
  if (!selection.ok) {
    return selection;
  }
  const { pluginId: requestedPluginId, plugin } = selection.value;
  if (!cli) {
    if (plugin?.origin === "bundled") {
      return err(`bundled plugin cannot be uninstalled: ${requestedPluginId}; disable it instead`);
    }
    if (!plugin && !Object.hasOwn(installRecords, requestedPluginId)) {
      return err(`Plugin not found: ${requestedPluginId}`);
    }
  }
  const ownership = createInstalledPluginOwnershipResolver(index, env).resolveLifecycle(
    requestedPluginId,
  );
  if (!ownership.ok) {
    return ownership;
  }
  const { installOwner: pluginId, pluginIds } = ownership.value;
  const policyPluginIds = pluginIds.length ? pluginIds : [pluginId];
  let channelIds: string[] | undefined;
  if (cli) {
    if (pluginIds.length === 1 && pluginIds[0] === requestedPluginId) {
      channelIds = plugin?.channelIds;
    } else if (pluginIds.length) {
      channelIds = uniqueStrings(
        pluginIds.flatMap((id) => plugins.find((entry) => entry.id === id)?.channelIds ?? []),
      );
    } else if (
      createInstalledPluginIndexScopeLookup(index).hasChannelContributionOwners([pluginId])
    ) {
      channelIds = [];
    }
  } else {
    const manifests = pluginIds.flatMap((id) => metadata?.byPluginId.get(id) ?? []);
    channelIds = manifests.length
      ? uniqueStrings(manifests.flatMap((manifest) => manifest.channels))
      : ownership.value.kind === "orphan" &&
          createInstalledPluginIndexScopeLookup(index).hasChannelContributionOwners([pluginId])
        ? []
        : undefined;
  }
  const runtimeLoadPaths = pluginIds.flatMap(
    (id) => plugins.find((entry) => entry.id === id)?.source ?? [],
  );
  const extensionsDir = resolveDefaultPluginExtensionsDir(cli ? undefined : env);
  const planForConfig = (source: OpenClawConfig) =>
    planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: withPluginInstallRecords(source, installRecords),
          pluginId,
          ...(channelIds !== undefined ? { channelIds } : {}),
          deleteFiles: !params.keepFiles,
          extensionsDir,
        },
        { runtimePluginIds: policyPluginIds, runtimeLoadPaths },
      ),
    );
  const plan = planForConfig(snapshot.config);
  if (!plan.ok) {
    return err(
      cli && plugin
        ? `Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`
        : plan.error,
    );
  }
  return ok({
    snapshot,
    installRecords,
    pluginId,
    requestedPluginId,
    pluginIds,
    policyPluginIds,
    name: plugin?.name || pluginId,
    channelIds,
    plan,
    planForConfig,
  });
}

/** Shared leased removal; callbacks preserve CLI output at its original mutation boundaries. */
export async function uninstallPluginWithPolicy(
  params: UninstallPolicy & {
    clawManaged?: boolean;
    invalidateRuntimeCache?: boolean;
    beforePersistentApply?: () => void;
    signal?: AbortSignal;
    applyRuntime?: PluginLifecycleRuntimeApply;
    deferRuntime?: PluginInstallRuntimeDeferral;
    onPreview?: (preview: PreparedPluginUninstall) => void | Promise<void>;
    onWarning?: (warning: string) => void;
    onComplete?: (result: PluginUninstallOutcome) => void;
  },
): Promise<Result<PluginUninstallOutcome, string>> {
  const env = params.env ?? process.env;
  const cli = params.caller === "cli";
  const applyRuntime = params.applyRuntime
    ? capturePluginRuntimeApplications(params.applyRuntime).applyRuntime
    : undefined;
  // Nested CLI calls inherit a Claw owner's exact database lease.
  return await withPluginLifecycleLease(
    { ...(cli ? {} : { env }), signal: params.signal },
    async (lease) => {
      const beforePersistentApply = () => {
        params.signal?.throwIfAborted();
        lease.assertOwned();
        params.beforePersistentApply?.();
      };
      beforePersistentApply();
      if (cli) {
        assertConfigWriteAllowedInCurrentMode();
      }
      const preparation = await preparePluginUninstall(params);
      if (!preparation.ok) {
        return preparation;
      }
      const prepared = preparation.value;
      await params.onPreview?.(prepared);
      const uninstall = async (): Promise<Result<PluginUninstallOutcome, string>> => {
        const {
          pluginId,
          requestedPluginId,
          pluginIds,
          policyPluginIds,
          installRecords,
          plan: initialPlan,
        } = prepared;
        const snapshot = prepared.snapshot;
        const assertConfigPathForWrite = () => {
          snapshot.writeOptions.assertConfigPathForWrite?.();
          beforePersistentApply();
        };
        let directoryResult: Awaited<ReturnType<typeof applyPluginUninstallDirectoryRemoval>> = {
          directoryRemoved: false,
          warnings: [],
        };
        if (initialPlan.directoryRemoval || applyRuntime) {
          // Retain source and ownership until runtime drain succeeds, even when keeping files.
          const disabledConfig = prepareConfigForDisabledPluginSet(
            snapshot.config,
            policyPluginIds,
            initialPlan.config,
          );
          const write = await runUninstallPhase(params, "config disable", () =>
            replaceConfigFile({
              sourceConfig: disabledConfig,
              baseHash: snapshot.baseHash,
              writeOptions: {
                ...snapshot.writeOptions,
                assertConfigPathForWrite,
                afterWrite:
                  params.applyRuntime || params.deferRuntime
                    ? { mode: "none", reason: "plugin lifecycle applies runtime" }
                    : { mode: "auto" },
              },
            }),
          );
          // Durable disable precedes drain; retain source files until the old runtime settles.
          await applyRuntime?.({
            config: disabledConfig,
            write,
            pluginIds: policyPluginIds,
            reason: "uninstall",
            assertInvokerOwned: beforePersistentApply,
          });
          beforePersistentApply();
          if (initialPlan.directoryRemoval) {
            const removal = initialPlan.directoryRemoval;
            directoryResult = await withPluginSourceCleanup(
              removal.target,
              {
                configPath: write.path,
                env,
                assertCurrent: beforePersistentApply,
                isReferenced: (config) => {
                  const current = prepared.planForConfig(config);
                  if (!current.ok) {
                    throw new Error(current.error);
                  }
                  // Keep uninstall's exact-match policy for parent and child load paths.
                  return current.actions.loadPath;
                },
              },
              (assertCurrent) => applyPluginUninstallDirectoryRemoval(removal, assertCurrent),
            );
          }
          for (const warning of directoryResult.warnings) {
            params.onWarning?.(warning);
          }
          if (
            initialPlan.directoryRemoval &&
            pluginUninstallTargetExists(initialPlan.directoryRemoval.target)
          ) {
            const message = `Failed to remove plugin directory ${cli ? shortenHomePath(initialPlan.directoryRemoval.target) : initialPlan.directoryRemoval.target}; the plugin remains disabled and tracked so uninstall can be retried.`;
            throw cli
              ? new Error(message)
              : new ManagedPluginLifecycleError(message, { kind: "unavailable" });
          }
        }
        const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
        const { expectedConfigPath, ownedConfigPathForWrite, auditOrigin } = snapshot.writeOptions;
        const io =
          !cli && params.env
            ? createConfigIO({
                configPath: ownedConfigPathForWrite ?? expectedConfigPath,
                env: cloneEnvWithPlatformSemantics(env),
              })
            : undefined;
        let commitReceipt:
          | Awaited<ReturnType<typeof commitPluginInstallRecordsWithConfig>>
          | undefined;
        const transform = () =>
          transformConfigFileWithRetry({
            base: "source",
            ...(io
              ? {
                  io: {
                    ...io,
                    readConfigFileSnapshotForWrite: () =>
                      createConfigIO({
                        configPath: io.configPath,
                        env: cloneEnvWithPlatformSemantics(env),
                      }).readConfigFileSnapshotForWrite(),
                  },
                }
              : {}),
            writeOptions: {
              ...(expectedConfigPath ? { expectedConfigPath } : {}),
              ...(ownedConfigPathForWrite ? { ownedConfigPathForWrite } : {}),
              ...(auditOrigin ? { auditOrigin } : {}),
              assertConfigPathForWrite,
              assertCurrent: beforePersistentApply,
              ...(cli || params.applyRuntime ? { allowConfigSizeDrop: true } : {}),
              ...(params.applyRuntime || params.deferRuntime
                ? {
                    afterWrite: {
                      mode: "none" as const,
                      reason: "plugin lifecycle applies runtime",
                    },
                  }
                : cli
                  ? { afterWrite: { mode: "restart" as const, reason: "plugin source changed" } }
                  : {}),
            },
            transform: (currentConfig) => {
              beforePersistentApply();
              const plan = prepared.planForConfig(currentConfig);
              if (!plan.ok) {
                throw cli ? new Error(plan.error) : new ManagedPluginLifecycleError(plan.error);
              }
              return { nextConfig: withoutPluginInstallRecords(plan.config), result: plan };
            },
            commit: async ({ nextConfig, baseHash, writeOptions, afterWrite }) => {
              const receipt = await commitPluginInstallRecordsWithConfig({
                previousInstallRecords: installRecords,
                nextInstallRecords,
                nextConfig,
                baseHash,
                beforePersistentEffect: beforePersistentApply,
                writeOptions: { ...writeOptions, afterWrite },
              });
              commitReceipt = receipt;
              return {
                config: receipt.configWrite.nextConfig,
                persistedHash: receipt.configWrite.persistedHash,
                persistedSourceConfig: receipt.configWrite.persistedSourceConfig,
                afterWrite: receipt.configWrite.afterWrite,
              };
            },
          });
        const mutation = await runUninstallPhase(params, "config mutation", () =>
          io
            ? withConfigWriteLock(io.configPath, transform, env, beforePersistentApply)
            : transform(),
        );
        const committed = expectDefined(commitReceipt, "plugin uninstall commit receipt");
        const plan = expectDefined(mutation.result, "committed plugin uninstall plan");
        const nextConfig = mutation.nextConfig;
        params.deferRuntime?.record({ operation: "uninstall", pluginId, write: committed });
        const warnings = [
          ...(!cli
            ? await collectClawPluginUninstallWarnings({
                pluginId,
                installRecord: installRecords[pluginId],
                env,
              })
            : []),
          ...(!cli && (requestedPluginId !== pluginId || pluginIds.length > 1)
            ? [
                `Uninstalled package "${pluginId}" and all owned plugin entries: ${pluginIds.join(", ")}.`,
              ]
            : []),
          ...directoryResult.warnings,
        ];
        await refreshPluginRegistryAfterConfigMutation({
          configPath: committed.configWrite.path,
          env,
          lease,
          reason: "source-changed",
          installRecords: nextInstallRecords,
          invalidateRuntimeCache: cli ? params.invalidateRuntimeCache : false,
          ...(cli ? { traceCommand: "uninstall" } : {}),
          logger: {
            warn: (message) => {
              warnings.push(message);
              params.onWarning?.(message);
            },
          },
        });
        if (!cli) {
          refreshManagedPluginMetadata({ config: nextConfig, env });
        }
        const application = await applyRuntime?.({
          config: nextConfig,
          write: committed.configWrite,
          pluginIds: policyPluginIds,
          reason: "uninstall",
          assertInvokerOwned: beforePersistentApply,
        });
        const result = {
          ...(application ? { application } : {}),
          pluginId,
          requestedPluginId,
          pluginIds,
          removed: formatUninstallActionLabels({
            ...plan.actions,
            loadPath: initialPlan.actions.loadPath || plan.actions.loadPath,
            directory: directoryResult.directoryRemoved,
          }),
          warnings: [...new Set([...warnings, ...(application?.warnings ?? [])])],
        };
        // Report committed work before either lease fence can raise a late ownership error.
        params.onComplete?.(result);
        return ok(result);
      };
      const record = prepared.installRecords[prepared.pluginId];
      const packageName =
        record?.source === "clawhub"
          ? (record.clawhubPackage ?? parseClawHubPluginSpec(record.spec ?? "")?.name)
          : undefined;
      if (params.clawManaged || !packageName || (!cli && !params.applyRuntime)) {
        return await uninstall();
      }
      return await withClawPackageLifecycleLease(
        { kind: "plugin", source: "clawhub", ref: packageName },
        uninstall,
        cli ? undefined : { env },
      );
    },
  );
}

/** Preserve the management API's canonical-id admission and response shape. */
export async function uninstallManagedPlugin(params: {
  pluginId: string;
  env?: NodeJS.ProcessEnv;
  keepFiles?: boolean;
  signal?: AbortSignal;
  beforePersistentApply?: () => void;
  applyRuntime?: PluginLifecycleRuntimeApply;
}): Promise<{
  pluginId: string;
  removed: string[];
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env, signal: params.signal }, async () => {
    const result = await uninstallPluginWithPolicy({ ...params, caller: "management" });
    if (!result.ok) {
      throw new ManagedPluginLifecycleError(result.error);
    }
    const { pluginId, removed, warnings, application } = result.value;
    return {
      pluginId,
      removed,
      ...(warnings.length ? { warnings } : {}),
      ...(application ? { application } : {}),
    };
  });
}
