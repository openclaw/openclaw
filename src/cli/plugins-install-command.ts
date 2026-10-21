// Owns CLI plugin installation and the shipped local/npm hook-pack fallback.
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { readInstallPolicyWarningErrorDetails } from "../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import type {
  PluginsInstallParams,
  PluginsInstallResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { assertConfigWriteAllowedInCurrentMode, replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { stageHookInstall } from "../hooks/install-record-transaction.js";
import {
  HOOK_INSTALL_ERROR_CODE,
  installHooksFromNpmSpec,
  installHooksFromPath,
  type InstallHooksResult,
} from "../hooks/install.js";
import type { HookInstallUpdate } from "../hooks/installs.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { buildNpmResolutionFields } from "../infra/install-source-utils.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub.js";
import {
  loadConfigForInstall,
  resolvePluginInstallRequestContext,
  PluginInstallConfigError,
  resolveFullyBlockedConfigMutationReason,
  type ConfigSnapshotForInstallExecution,
} from "../plugins/install-config.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import { PluginInstallPersistedError } from "../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import { installManagedPlugin } from "../plugins/management-mutations.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { resolveClawHubInstallConfirmation } from "./clawhub-install-confirmation.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { confirmNonClawHubInstall } from "./non-clawhub-install-acknowledgement.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import {
  createPluginInstallLogger,
  formatPluginInstallWithHookFallbackError,
} from "./plugins-command-helpers.js";
import {
  resolvePluginInstallPreflight,
  type RunPluginInstallCommandParams,
} from "./plugins-install-preflight.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";
import { runWithLocalPluginState } from "./plugins-local-state.js";

const DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING =
  "--dangerously-force-unsafe-install is deprecated and no longer affects plugin installs because built-in install-time dangerous-code scanning has been removed. Configure security.installPolicy for operator-owned install decisions.";

/** Validate intent and select the runtime owner before either process acquires its lease. */
export async function runPluginInstallCommand(params: RunPluginInstallCommandParams) {
  assertConfigWriteAllowedInCurrentMode();
  const runtime = params.runtime ?? defaultRuntime;
  const preflight = await resolvePluginInstallPreflight(params);
  if (!preflight.ok) {
    runtime.error(preflight.error);
    return runtime.exit(1);
  }
  const { raw, opts, sourcePlan } = preflight;
  if (opts.dangerouslyForceUnsafeInstall) {
    runtime.log(theme.warn(DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING));
  }
  const acknowledgment =
    sourcePlan?.acknowledgement ??
    (preflight.marketplace
      ? { sourceClass: "marketplace" as const, spec: `${raw} from ${preflight.marketplace}` }
      : undefined);
  if (
    acknowledgment &&
    !(await confirmNonClawHubInstall({
      acknowledged: opts.force,
      runtime,
      ...acknowledgment,
    }))
  ) {
    return runtime.exit(1);
  }
  let result: Awaited<ReturnType<typeof installPluginWithHookFallback>>;
  try {
    const snapshot = await loadConfigForInstall(preflight.request).catch((error: unknown) => {
      // The shipped hook-only path may still be writable when plugin config is blocked.
      if (error instanceof PluginInstallConfigError && error.blockedSnapshot) {
        return error.blockedSnapshot;
      }
      throw error;
    });
    // An enclosing lifecycle lease or in-process authority guard cannot cross
    // the Gateway RPC boundary.
    const gateway =
      params.applyRuntime || params.beforePersistentApply || hasPluginLifecycleLease()
        ? null
        : await resolvePluginLifecycleGateway();
    const request = sourcePlan?.request ?? {
      source: "marketplace" as const,
      marketplace: preflight.marketplace!,
      plugin: raw,
      mode: preflight.installMode,
    };
    if (sourcePlan?.warning) {
      runtime.log(theme.warn(sourcePlan.warning));
    }
    result = await installPluginWithHookFallback({
      request: { ...request, ...(opts.enable === false ? { enable: false } : {}) },
      snapshot,
      runtime,
      applyRuntime: params.applyRuntime,
      beforePersistentApply: params.beforePersistentApply,
      invalidateRuntimeCache: params.invalidateRuntimeCache ?? true,
      install: gateway
        ? async (installParams) => {
            if (
              installParams.request.source === "clawhub" &&
              installParams.request.mode !== "update" &&
              installParams.confirmInstall &&
              !(await installParams.confirmInstall())
            ) {
              throw new ManagedPluginLifecycleError("Install cancelled.", {
                installRejected: true,
              });
            }
            installParams.signal?.throwIfAborted();
            installParams.beforePersistentApply?.();
            let gatewayResult: PluginsInstallResult;
            try {
              try {
                gatewayResult = await gateway<PluginsInstallResult>(
                  "plugins.install",
                  installParams.request,
                  installParams.onCapabilityConsent,
                );
              } catch (error) {
                const details = readInstallPolicyWarningErrorDetails(
                  error instanceof Error && "details" in error ? error.details : undefined,
                );
                if (
                  !details ||
                  !installParams.safetyOverrides?.onInstallPolicyWarning ||
                  (await installParams.safetyOverrides.onInstallPolicyWarning(details)).status !==
                    "approved"
                ) {
                  throw error;
                }
                gatewayResult = await gateway<PluginsInstallResult>(
                  "plugins.install",
                  { ...installParams.request, acknowledgeInstallPolicyWarning: true },
                  installParams.onCapabilityConsent,
                );
              }
            } catch (error) {
              const details =
                error instanceof Error && "details" in error ? error.details : undefined;
              const saved = isRecord(details) ? details.persistence : undefined;
              if (
                isRecord(saved) &&
                saved.operation === "install" &&
                typeof saved.pluginId === "string"
              ) {
                throw new PluginInstallPersistedError(saved.pluginId, error);
              }
              // Only an explicit install-owner refusal permits hook fallback. A lost reply
              // or runtime-apply failure can follow a committed plugin mutation.
              if (isRecord(details) && details.pluginInstallRejected === true) {
                const source = details.pluginInstallSource;
                const installSource: ManagedPluginLifecycleError["installSource"] =
                  isRecord(source) &&
                  (source.source === "npm" || source.source === "clawhub") &&
                  typeof source.spec === "string"
                    ? {
                        source: source.source,
                        spec: source.spec,
                        ...(typeof source.expectedIntegrity === "string"
                          ? { expectedIntegrity: source.expectedIntegrity }
                          : {}),
                      }
                    : undefined;
                throw new ManagedPluginLifecycleError(
                  error instanceof Error ? error.message : String(error),
                  {
                    installRejected: true,
                    installSource,
                    ...(typeof details.pluginInstallCode === "string"
                      ? { code: details.pluginInstallCode }
                      : {}),
                    cause: error,
                  },
                );
              }
              throw error;
            }
            return {
              plugin: gatewayResult.plugin,
              warnings: gatewayResult.warnings,
              application: gatewayResult.runtime,
            };
          }
        : (installParams) =>
            runWithLocalPluginState("install", (assertCurrent) =>
              installManagedPlugin({
                ...installParams,
                beforePersistentApply: () => {
                  assertCurrent();
                  installParams.beforePersistentApply?.();
                },
              }),
            ),
      logger: createPluginInstallLogger(runtime),
      confirmInstall: resolveClawHubInstallConfirmation(),
      ...resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: opts.acceptCapabilities,
        action: "install",
        runtime,
      }),
      safetyOverrides: {
        config: snapshot.config,
        onInstallPolicyWarning: opts.onInstallPolicyWarning,
        trustedSourceLinkedOfficialInstall: opts.trustedSourceLinkedOfficialInstall,
        ...resolveInstallPolicyWarningAcknowledgementCliOptions({
          acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
          allowPrompt: params.allowInstallPolicyWarningPrompt,
        }),
      },
    });
  } catch (error) {
    runtime.error(formatErrorMessage(error));
    return runtime.exit(1);
  }
  if (!result.ok) {
    if (
      result.code !== CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED ||
      !result.warning?.trim()
    ) {
      runtime.error(result.error);
    }
    return runtime.exit(1);
  }
}

type HookCompatibleSource = Extract<PluginsInstallParams, { source: "local" | "npm" }>;
type InstallParams = Parameters<typeof installManagedPlugin>[0] & {
  snapshot: ConfigSnapshotForInstallExecution;
  install?: typeof installManagedPlugin;
  runtime?: RuntimeEnv;
};
type InstallResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      code?: string;
      warning?: string;
      installSource?: ManagedPluginLifecycleError["installSource"];
    };

async function attemptHookInstall(
  source: HookCompatibleSource,
  params: InstallParams,
  options?: {
    inspection?: "package-kind";
    expectedPackageKind?: "hook-only";
    beforePersistentApply?: () => void;
  },
  assertOwned?: () => void,
): Promise<InstallHooksResult> {
  const runtime = params.runtime ?? defaultRuntime;
  const common = requestDeferredPackageDirInstall(
    {
      ...params.safetyOverrides,
      config: params.snapshot.config,
      mode: source.mode,
      logger: {
        info: (message: string) => runtime.log(message),
        warn: (message: string) => runtime.log(theme.warn(message)),
      },
      ...options,
    },
    assertOwned,
  );
  try {
    return source.source === "local"
      ? await installHooksFromPath({
          ...common,
          path: source.path,
          ...(source.link ? { dryRun: true } : {}),
        })
      : await installHooksFromNpmSpec({
          ...common,
          spec: source.spec,
          ...(source.expectedIntegrity ? { expectedIntegrity: source.expectedIntegrity } : {}),
        });
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}

async function installHookPack(
  source: HookCompatibleSource,
  params: InstallParams,
  expectedPackageKind?: "hook-only",
): Promise<InstallResult> {
  if (params.request.enable === false) {
    return {
      ok: false,
      error:
        "--no-enable is only supported for plugins. Install hook packs separately with openclaw hooks install.",
    };
  }
  return await runWithLocalPluginState("install (hook fallback)", (assertCurrent) =>
    installHookPackLocal(source, params, expectedPackageKind, assertCurrent),
  );
}

async function installHookPackLocal(
  source: HookCompatibleSource,
  params: InstallParams,
  expectedPackageKind: "hook-only" | undefined,
  assertCurrent: () => void,
): Promise<InstallResult> {
  // Online plugin rejection can precede this fallback; acquire and reread only for the hook write.
  return await withPluginLifecycleLease({ signal: params.signal }, async (lease) => {
    const request = resolvePluginInstallRequestContext({
      rawSpec: source.source === "local" ? source.path : source.spec,
      source: source.source,
    });
    if (!request.ok) {
      return request;
    }
    const snapshot = await loadConfigForInstall(request.request).catch((error: unknown) => {
      if (
        expectedPackageKind === "hook-only" &&
        error instanceof PluginInstallConfigError &&
        error.blockedSnapshot
      ) {
        // A verified hook artifact uses the fresh hook preflight even when
        // its official package identity independently blocks plugin writes.
        return error.blockedSnapshot;
      }
      throw error;
    });
    if (snapshot.hookMutation.mode === "blocked") {
      return { ok: false, error: snapshot.hookMutation.reason };
    }
    const linked = source.source === "local" && source.link;
    if (linked && !fs.statSync(source.path).isDirectory()) {
      return { ok: false, error: "Linked hook pack paths must be directories." };
    }
    const beforePersistentApply = () => {
      assertCurrent();
      params.signal?.throwIfAborted();
      lease.assertOwned();
      snapshot.writeOptions.assertConfigPathForWrite?.();
      params.beforePersistentApply?.();
    };
    const result = await attemptHookInstall(
      source,
      { ...params, snapshot },
      { expectedPackageKind, beforePersistentApply },
      lease.assertOwned.bind(lease),
    );
    if (!result.ok) {
      return result;
    }
    const runtime = params.runtime ?? defaultRuntime;
    const config = snapshot.config;
    const pinMessages: string[] = [];
    const persistedSnapshot = linked
      ? {
          ...snapshot,
          config: {
            ...config,
            hooks: {
              ...config.hooks,
              internal: {
                ...config.hooks?.internal,
                load: {
                  ...config.hooks?.internal?.load,
                  extraDirs: uniqueStrings([
                    ...(config.hooks?.internal?.load?.extraDirs ?? []),
                    source.path,
                  ]),
                },
              },
            },
          },
        }
      : snapshot;
    const resolvedSpec = result.npmResolution?.resolvedSpec;
    if (source.source === "npm" && source.pin) {
      pinMessages.push(
        resolvedSpec
          ? `Pinned npm install record to ${resolvedSpec}.`
          : theme.warn("Could not resolve exact npm version for --pin; storing original npm spec."),
      );
    }
    const installRecord: Omit<HookInstallUpdate, "hookId" | "hooks"> =
      source.source === "local"
        ? {
            source: resolveArchiveKind(source.path) ? "archive" : "path",
            sourcePath: source.path,
            installPath: linked ? source.path : result.targetDir,
            version: result.version,
          }
        : {
            source: "npm",
            spec: source.pin && resolvedSpec ? resolvedSpec : source.spec,
            installPath: result.targetDir,
            version: result.version,
            ...buildNpmResolutionFields(result.npmResolution),
          };
    await withPluginLifecycleLease({}, async (persistenceLease) => {
      const assertPersistentApply = () => {
        persistenceLease.assertOwned();
        persistedSnapshot.writeOptions.assertConfigPathForWrite?.();
        beforePersistentApply();
      };
      const persistedConfig = persistedSnapshot.config;
      const entries = { ...persistedConfig.hooks?.internal?.entries };
      for (const hookName of result.hooks) {
        entries[hookName] = { ...entries[hookName], enabled: true };
      }
      const next: OpenClawConfig = {
        ...persistedConfig,
        hooks: {
          ...persistedConfig.hooks,
          internal: {
            ...persistedConfig.hooks?.internal,
            enabled: true,
            entries,
          },
        },
      };
      const transaction = await stageHookInstall({
        update: { hookId: result.hookPackId, hooks: result.hooks, ...installRecord },
        payloadTransaction: resolvePackageDirInstallTransaction(result),
        lease: persistenceLease,
        beforePersistentApply: assertPersistentApply,
      });
      try {
        await replaceConfigFile({
          nextConfig: next,
          baseHash: persistedSnapshot.baseHash,
          writeOptions: {
            ...persistedSnapshot.writeOptions,
            assertConfigPathForWrite: assertPersistentApply,
          },
        });
      } catch (error) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Hook install config rollback failed", {
            cause: rollbackError,
          });
        }
        throw error;
      }
      await transaction.commit();
      runtime.log(
        linked
          ? `Linked hook pack path: ${shortenHomePath(source.path)}`
          : `Installed hook pack: ${result.hookPackId}`,
      );
      runtime.log(
        "Hook install/link config can activate immediately in hybrid mode; code-only updates and reload mode off need a Gateway restart.",
      );
      return next;
    });
    // Output failures must not strand a payload whose config has not committed.
    for (const message of pinMessages) {
      runtime.log(message);
    }
    return { ok: true };
  });
}

async function installInspectedHookPack(
  source: HookCompatibleSource,
  params: InstallParams,
): Promise<InstallResult | undefined> {
  const probe = await attemptHookInstall(source, params, { inspection: "package-kind" });
  if (!probe.ok) {
    // A package without hook manifest entries is a confirmed negative. Any other
    // failure leaves the artifact unidentified, so its reason must stay visible
    // beside the original rejection the caller still returns.
    if (
      probe.code !== HOOK_INSTALL_ERROR_CODE.MISSING_OPENCLAW_HOOKS &&
      probe.code !== HOOK_INSTALL_ERROR_CODE.EMPTY_OPENCLAW_HOOKS
    ) {
      (params.runtime ?? defaultRuntime).log(
        theme.warn(`Hook-pack fallback skipped: package inspection failed: ${probe.error}`),
      );
    }
    return undefined;
  }
  if (probe.packageKind !== "hook-only") {
    return undefined;
  }
  const pinned =
    source.source !== "local" && probe.npmResolution?.integrity
      ? { ...source, expectedIntegrity: probe.npmResolution.integrity }
      : source;
  return await installHookPack(pinned, params, "hook-only");
}

/** Every source uses the same plugin executor; hook fallback needs an eligible artifact. */
async function installPluginWithHookFallback(params: InstallParams): Promise<InstallResult> {
  const { request, snapshot, install: execute = installManagedPlugin, ...options } = params;
  const compatible = request.source === "local" || request.source === "npm" ? request : undefined;
  const blocked = resolveFullyBlockedConfigMutationReason(snapshot);
  if (blocked) {
    return { ok: false, error: blocked };
  }
  if (compatible) {
    if (snapshot.pluginMutation.mode === "blocked" || snapshot.hookMutation.mode === "blocked") {
      const hook = await installInspectedHookPack(compatible, params);
      if (hook) {
        return hook;
      }
      if (snapshot.pluginMutation.mode === "blocked") {
        return { ok: false, error: snapshot.pluginMutation.reason };
      }
    }
  }
  const install = async (installRequest: PluginsInstallParams): Promise<InstallResult> => {
    const runtime = params.runtime ?? defaultRuntime;
    const logWarning = options.logger?.warn ?? createPluginInstallLogger(runtime).warn;
    const warnings = new Set<string>();
    // Local installs stream warnings that also appear in the final result;
    // Gateway installs only return them. Both routes share one terminal sink.
    const warn = (message: string) => {
      if (!warnings.has(message)) {
        warnings.add(message);
        logWarning(message);
      }
    };
    try {
      const result = await execute({
        ...options,
        logger: { ...options.logger, warn },
        request: installRequest,
      });
      for (const warning of result.warnings ?? []) {
        warn(warning);
      }
      runtime.log(
        installRequest.source === "local" && installRequest.link
          ? `Linked plugin path: ${shortenHomePath(installRequest.path)}`
          : `Installed plugin: ${result.plugin.id}`,
      );
      runtime.log(
        result.application
          ? `Applied in Gateway generation ${result.application.generation}.`
          : "Saved for the next Gateway start.",
      );
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ManagedPluginLifecycleError) || !error.installRejected) {
        throw error;
      }
      return {
        ok: false,
        error: error.message,
        code: error.code,
        warning: error.warning,
        installSource: error.installSource,
      };
    }
  };
  const result = await install(request);
  if (result.ok) {
    return result;
  }
  const selectedSource = result.installSource;
  // Only the install owner knows which declared artifact failed. A ClawHub
  // rejection must never probe an npm namesake or the catalog's display id.
  const hookSource: HookCompatibleSource | undefined =
    request.source === "official" &&
    (result.code === PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS ||
      result.code === PLUGIN_INSTALL_ERROR_CODE.CONFIG_MUTATION_BLOCKED) &&
    selectedSource?.source === "npm"
      ? {
          source: "npm",
          spec: selectedSource.spec,
          expectedIntegrity: selectedSource.expectedIntegrity,
          mode: request.mode,
          pin: request.pin,
        }
      : compatible;
  if (result.code === PLUGIN_INSTALL_ERROR_CODE.CONFIG_MUTATION_BLOCKED) {
    return (hookSource && (await installInspectedHookPack(hookSource, params))) ?? result;
  }
  if (
    !hookSource ||
    [
      PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
      PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED,
      PLUGIN_INSTALL_ERROR_CODE.RELEASE_COHORT_UNAVAILABLE,
      PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN,
    ].some((code) => code === result.code)
  ) {
    return result;
  }
  const hook = await installHookPack(hookSource, params);
  return hook.ok
    ? hook
    : { ...result, error: formatPluginInstallWithHookFallbackError(result.error, hook) };
}
