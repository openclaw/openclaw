import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import { createPluginInstallLogger } from "../cli/plugins-command-helpers.js";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  normalizePluginId,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "../plugins/config-state.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import { preparePluginFromPath } from "../plugins/install-package.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolvePluginInstallDir,
} from "../plugins/install-paths.js";
import { formatInstallPolicyNotice } from "../plugins/install-policy-notice.js";
import type { InstallPolicyWarningDetails } from "../plugins/install-security-scan.types.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { installManagedPlugin } from "../plugins/management-mutations.js";
import { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import { withPluginLifecycleLeaseAsync } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../runtime.js";
import { inspectTemplateBundledPluginDirectory } from "./bundled-plugin-metadata.js";
import {
  materializeTemplateDependencyDirectory,
  snapshotTemplateDependencyDirectory,
  type TemplateDirectorySnapshot,
} from "./dependency-directory.js";
import { digestTemplateBytes, digestTemplateValue } from "./digest.js";
import type { InstallTemplatePackagesOptions } from "./package-install-options.js";
import type { PlannedTemplateBundledDependency } from "./package-plan-action.js";
import { resolveTemplatePluginSetupRequirements } from "./package-setup-requirements.js";
import {
  createStatelessTemplatePackageReceipt,
  type TemplatePackageReceipt,
} from "./package-stateless-receipt.js";
import {
  inspectTemplatePluginCapabilities,
  sourceHostPluginConflict,
} from "./plugin-capability-probe.js";
import type {
  TemplateAddPlan,
  TemplateBundledDependency,
  TemplatePackagePreflightResult,
} from "./types.js";

const policySource = {
  kind: "archive",
  authority: "third-party",
  mutable: false,
  network: false,
} as const;
const installStamps = new WeakMap<TemplatePackageReceipt, string>();

// Native source and dependency scans can repeat the same warning before commit.
function policyWarningDigest(warnings: InstallPolicyWarningDetails[]): string | undefined {
  return warnings.length
    ? digestTemplateValue(
        [...new Set(warnings.map((warning) => stableStringify(warning)))].toSorted(),
      )
    : undefined;
}

export class BundledTemplatePluginInstallError extends Error {
  readonly code: string;
  constructor(
    message: string,
    readonly receipt?: TemplatePackageReceipt,
    options?: ErrorOptions & { code?: string },
  ) {
    super(message, options);
    this.name = "BundledTemplatePluginInstallError";
    this.code = options?.code ?? "package_install_failed";
  }
}

/** Inspect with the same native archive owner that will install the reviewed bytes. */
export async function preflightBundledTemplatePlugin(params: {
  dependency: TemplateBundledDependency;
  rootDir: string;
  snapshot: TemplateDirectorySnapshot;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<TemplatePackagePreflightResult> {
  const { dependency, config, env } = params;
  try {
    await using prepared = await materializeTemplateDependencyDirectory({
      rootDir: params.rootDir,
      path: dependency.path,
      snapshot: params.snapshot,
    });
    await using isolated = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-template-plugin-probe-",
    });
    const records = await loadInstalledPluginIndexInstallRecords({ env });
    let inspected: ReturnType<typeof inspectTemplatePluginCapabilities> | undefined;
    const warnings: InstallPolicyWarningDetails[] = [];
    const request: Parameters<typeof preparePluginFromPath>[0] = {
      path: await prepared.createArchive(),
      extensionsDir: isolated.dir,
      config,
      installPolicyRequest: { kind: "plugin-archive", source: policySource },
      onPluginArtifactInspect: async (artifact) => {
        inspected = inspectTemplatePluginCapabilities(
          artifact.stagedArtifactDir,
          artifact.pluginId,
          env,
          config,
          records[artifact.pluginId]?.installPath,
        );
      },
    };
    const probe = await preparePluginFromPath({
      ...request,
      onInstallPolicyWarning: async (warning) => {
        warnings.push(warning);
        return { status: "approved" };
      },
    });
    if (!probe.ok) {
      return { ok: false, code: probe.code ?? "bundled_plugin_invalid", message: probe.error };
    }
    if (!inspected || !probe.artifactInspection || probe.artifactInspection.format === "agent") {
      return {
        ok: false,
        code: "plugin_artifact_inspection_unavailable",
        message: `Plugin ${dependency.path} has no supported canonical artifact inspection.`,
      };
    }
    const conflict = await sourceHostPluginConflict(dependency, probe.pluginId, params);
    if (conflict) {
      return { ok: false, code: "plugin_source_host_conflict", message: conflict };
    }
    if (config) {
      const normalized = normalizePluginsConfig(config.plugins);
      const enabled = resolveEffectiveEnableState({
        id: normalizePluginId(probe.pluginId),
        origin: "global",
        config: normalized,
        rootConfig: config,
      });
      if (!enabled.enabled) {
        return {
          ok: false,
          code: "plugin_disabled",
          message: `Plugin ${dependency.path} is disabled by host policy (${enabled.reason ?? "disabled"}). Enable it in Plugins before adding this Template.`,
        };
      }
    }
    const installed = records[probe.pluginId];
    const target =
      installed?.installPath ??
      resolvePluginInstallDir(probe.pluginId, resolveDefaultPluginExtensionsDir(env));
    const exists = await lstat(target).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (installed || exists) {
      if (
        !installed ||
        !exists ||
        (await snapshotTemplateDependencyDirectory({ rootDir: target })).digest !==
          params.snapshot.digest
      ) {
        return {
          ok: false,
          code: "bundled_plugin_conflict",
          message: `Plugin ${probe.pluginId} already exists with different or unmanaged contents.`,
        };
      }
    }
    const requirements = resolveTemplatePluginSetupRequirements({
      pluginId: probe.pluginId,
      setup: probe.setup,
      env: env ?? process.env,
    });
    return {
      ok: true,
      action: installed ? "reuse" : "install",
      snapshot: params.snapshot,
      name: inspectTemplateBundledPluginDirectory(prepared.directory).name,
      installId: probe.pluginId,
      detectedFormat: probe.artifactInspection.format,
      mapped: probe.artifactInspection.mapped,
      unavailable: probe.artifactInspection.unavailable,
      adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
      declaredCapabilities: inspected.declared,
      capabilityGrants: inspected.grants,
      capabilityGrantsByPluginId: inspected.grantsByPluginId,
      ...(requirements.length ? { requirements } : {}),
      ...(warnings.length
        ? {
            warning: [
              ...new Set(
                warnings.map((warning) =>
                  formatInstallPolicyNotice({
                    ...warning,
                    decision: "warn",
                  }),
                ),
              ),
            ].join("\n\n"),
            installPolicyWarningDigest: policyWarningDigest(warnings),
          }
        : {}),
    };
  } catch (error) {
    return { ok: false, code: "bundled_plugin_invalid", message: coerceErrorMessage(error) };
  }
}

export async function installBundledTemplatePlugin(params: {
  plan: TemplateAddPlan;
  dependency: PlannedTemplateBundledDependency;
  options: InstallTemplatePackagesOptions;
}): Promise<TemplatePackageReceipt> {
  const { plan, dependency, options } = params;
  const changed = () =>
    new BundledTemplatePluginInstallError(
      `Plugin ${dependency.path} changed after planning; review the Template again.`,
      undefined,
      { code: "package_owner_state_changed" },
    );
  const preflight = await preflightBundledTemplatePlugin({
    dependency,
    rootDir: plan.template.packageRoot,
    snapshot: dependency.snapshot,
    config: options.config,
    env: options.env,
  });
  if (
    !preflight.ok ||
    preflight.action !== dependency.ownerAction ||
    preflight.name !== dependency.name ||
    preflight.installId !== dependency.installId ||
    preflight.warning !== dependency.riskWarning ||
    preflight.installPolicyWarningDigest !== dependency.installPolicyWarningDigest ||
    !dependency.extension ||
    stableStringify({
      detectedFormat: preflight.detectedFormat,
      mapped: preflight.mapped,
      unavailable: preflight.unavailable,
      adapterIdentity: preflight.adapterIdentity,
    }) !==
      stableStringify({
        detectedFormat: dependency.extension.detectedFormat,
        mapped: dependency.extension.mapped,
        unavailable: dependency.extension.unavailable,
        adapterIdentity: dependency.extension.adapterIdentity,
      }) ||
    !dependency.declaredCapabilities ||
    !dependency.capabilityGrants ||
    !dependency.capabilityGrantsByPluginId ||
    stableStringify(preflight.declaredCapabilities) !==
      stableStringify(dependency.declaredCapabilities) ||
    stableStringify(preflight.capabilityGrants) !== stableStringify(dependency.capabilityGrants) ||
    stableStringify(preflight.capabilityGrantsByPluginId) !==
      stableStringify(dependency.capabilityGrantsByPluginId)
  ) {
    throw changed();
  }
  options.assertCurrent?.();
  if (preflight.action === "reuse") {
    return createStatelessTemplatePackageReceipt(plan, dependency, {
      nowMs: options.nowMs,
      status: "complete",
      relationship: "referenced",
      origin: "pre-existing",
      independentOwner: true,
    });
  }
  const consent = options.pluginConsent;
  if (!consent) {
    throw new BundledTemplatePluginInstallError(
      `Plugin ${dependency.path} requires an explicit Template capability acknowledgment.`,
      undefined,
      { code: "plugin_consent_required" },
    );
  }
  const receipt = createStatelessTemplatePackageReceipt(plan, dependency, {
    nowMs: options.nowMs,
    status: "pending",
    relationship: "referenced",
    origin: "template-introduced",
    independentOwner: false,
  });
  await using prepared = await materializeTemplateDependencyDirectory({
    rootDir: plan.template.packageRoot,
    path: dependency.path,
    snapshot: dependency.snapshot,
  });
  const archive = await prepared.createArchive();
  const integrity = digestTemplateBytes(await readFile(archive));
  const sourcePath = resolve(plan.template.packageRoot, dependency.path);
  const stampInstalled = async () => {
    const record = (await loadInstalledPluginIndexInstallRecords({ env: options.env }))[
      dependency.installId
    ];
    if (record?.integrity === integrity && record.sourcePath === sourcePath) {
      installStamps.set(receipt, digestTemplateValue(record));
    }
  };
  const assertCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  try {
    assertCurrent();
    const runtime = options.runtime ?? defaultRuntime;
    const warnings: InstallPolicyWarningDetails[] = [];
    const installed = await installManagedPlugin({
      request: { source: "local", path: archive, mode: "install" },
      localArtifact: { sourcePath, integrity, policySource },
      env: options.env,
      logger: createPluginInstallLogger(runtime),
      templateManaged: true,
      invalidateRuntimeCache: false,
      deferRuntime: options.runtimeBatch?.install(),
      beforePersistentApply: assertCurrent,
      beforePersistentEffect: async () => {
        await options.prepareEffect?.();
        assertCurrent();
      },
      safetyOverrides: {
        onInstallPolicyWarning: async (warning) => {
          assertCurrent();
          if (
            !dependency.riskWarning ||
            !(await consent.confirmInstall?.(dependency.installId, dependency.riskWarning))
          ) {
            throw changed();
          }
          warnings.push(warning);
          return { status: "approved" };
        },
      },
      onCapabilityConsent: async (review) => {
        assertCurrent();
        if (
          stableStringify(review.declared) !== stableStringify(dependency.declaredCapabilities) ||
          stableStringify(review.grants) !== stableStringify(dependency.capabilityGrants)
        ) {
          throw changed();
        }
        return await consent.onCapabilityConsent(review);
      },
      onBeforePluginArtifactCommit: async (artifact) => {
        assertCurrent();
        if (policyWarningDigest(warnings) !== dependency.installPolicyWarningDigest) {
          throw changed();
        }
        if (
          artifact.pluginId !== dependency.installId ||
          (await snapshotTemplateDependencyDirectory({ rootDir: artifact.stagedArtifactDir }))
            .digest !== dependency.snapshot.digest
        ) {
          throw changed();
        }
        const { snapshot } = await readConfigFileSnapshotForWrite();
        const current = inspectTemplatePluginCapabilities(
          artifact.stagedArtifactDir,
          artifact.pluginId,
          options.env,
          snapshot.sourceConfig,
          artifact.currentArtifactDir,
        );
        if (
          stableStringify(current.grantsByPluginId) !==
          stableStringify(dependency.capabilityGrantsByPluginId)
        ) {
          throw changed();
        }
      },
    });
    for (const warning of installed.warnings ?? []) {
      runtime.log(warning);
    }
    await stampInstalled();
    assertCurrent();
    receipt.status = "complete";
    receipt.updatedAtMs = options.nowMs ?? Date.now();
    return receipt;
  } catch (error) {
    let failure = error;
    try {
      await stampInstalled();
    } catch (stampError) {
      failure = new AggregateError([error, stampError], coerceErrorMessage(error));
    }
    throw new BundledTemplatePluginInstallError(coerceErrorMessage(failure), receipt, {
      cause: failure,
      code: error instanceof BundledTemplatePluginInstallError ? error.code : undefined,
    });
  }
}

export async function rollbackBundledTemplatePlugins(
  receipts: TemplatePackageReceipt[],
  options: Pick<
    InstallTemplatePackagesOptions,
    "assertCurrent" | "prepareEffect" | "env" | "path" | "runtime"
  > = {},
): Promise<string[]> {
  if (
    !receipts.some(
      (receipt) =>
        receipt.source === "bundled" && receipt.kind === "plugin" && installStamps.has(receipt),
    )
  ) {
    return [];
  }
  return await withPluginLifecycleLeaseAsync(options, async () => {
    const errors: string[] = [];
    for (const receipt of receipts.toReversed()) {
      const stamp = installStamps.get(receipt);
      if (
        receipt.source !== "bundled" ||
        receipt.kind !== "plugin" ||
        !stamp ||
        receipt.origin !== "template-introduced"
      ) {
        continue;
      }
      try {
        const assertRecord = async () => {
          options.assertCurrent?.();
          const record = (await loadInstalledPluginIndexInstallRecords({ env: options.env }))[
            receipt.installId
          ];
          if (!record || digestTemplateValue(record) !== stamp) {
            throw new Error("Plugin ownership changed before cleanup.");
          }
        };
        await assertRecord();
        const result = await uninstallPluginWithPolicy({
          pluginId: receipt.installId,
          env: options.env,
          caller: "cli",
          templateManaged: true,
          invalidateRuntimeCache: false,
          beforePersistentApply: options.assertCurrent,
          beforePersistentEffect: async () => {
            await options.prepareEffect?.();
            options.assertCurrent?.();
          },
          onWarning: (warning) => (options.runtime ?? defaultRuntime).log(warning),
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        receipt.status = "rolled_back";
      } catch (error) {
        errors.push(`Plugin ${receipt.path} cleanup failed: ${coerceErrorMessage(error)}`);
      }
    }
    return errors;
  });
}
