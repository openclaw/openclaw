// Plugin synchronization and convergence after the core update.
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { VERSION_BOUND_RUNTIME_PLUGIN_IDS } from "../../commands/doctor/shared/configured-runtime-plugin-installs.js";
import { runPostCorePluginConvergence } from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { comparePackageUpdateVersions } from "../../infra/package-update-utils.js";
import { resolveRegistryUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import { getLogger } from "../../logging/logger.js";
import type { PluginCapabilityConsentHandler } from "../../plugins/capability-consent.js";
import { commitPluginInstallRecordsWithConfig } from "../../plugins/install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { isTrustedOfficialPluginInstallRecord } from "../../plugins/official-external-install-records.js";
import type { MissingPluginInstallPayload } from "../../plugins/payload-verification.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { convergePluginReleaseCohort } from "../../plugins/update-cohort.js";
import {
  resolveExactNpmSpecVersion,
  resolveNpmSpecPackageName,
} from "../../plugins/update-source.js";
import {
  isClawHubTrustSkippedOutcome,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateOutcome,
} from "../../plugins/update.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { resolvePluginCapabilityConsentCliOptions } from "../plugin-capability-consent.js";
import { listPersistedBundledPluginLocationBridges } from "../plugins-location-bridges.js";
import { readPackageVersion } from "./shared.js";
import {
  buildInvalidConfigPostCoreUpdateResult,
  createPluginUpdateWarning,
  type PluginUpdateWarning,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins-internals.js";

export type { PostCorePluginUpdateResult } from "./update-command-plugins-internals.js";

function formatPluginUpdateWarning(message: string): string {
  return message.includes("╭─") ? message : theme.warn(message);
}

function formatMissingPluginPayloadReason(entry: MissingPluginInstallPayload): string {
  if (entry.reason === "missing-install-path") {
    return "installPath is missing";
  }
  if (entry.reason === "missing-package-json") {
    return `package.json is missing under ${entry.installPath}`;
  }
  return `package directory is missing: ${entry.installPath}`;
}

function collectPluginChannelFallbackMessages(outcomes: readonly PluginUpdateOutcome[]): string[] {
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const outcome of outcomes) {
    const message = outcome.channelFallback?.message;
    if (!message || seen.has(message)) {
      continue;
    }
    seen.add(message);
    messages.push(message);
  }
  return messages;
}

function isDisabledAfterFailureOutcome(outcome: PluginUpdateOutcome): boolean {
  return outcome.status === "skipped" && outcome.message.includes("after plugin update failure");
}

function isActionableSkippedPostUpdateOutcome(outcome: PluginUpdateOutcome): boolean {
  return isDisabledAfterFailureOutcome(outcome) || isClawHubTrustSkippedOutcome(outcome);
}

export async function updatePluginsAfterCoreUpdate(params: {
  root: string;
  beforePersistentEffect?: () => void | Promise<void>;
  channel: UpdateChannel;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  configWriteOptions: ConfigWriteOptions;
  configChanged?: boolean;
  restoredAuthoredChannels?: unknown;
  timeoutMs: number;
  pluginInstallRecords?: Record<string, PluginInstallRecord>;
  json?: boolean;
  acceptCapabilities?: boolean;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  runtime?: RuntimeEnv;
}): Promise<PostCorePluginUpdateResult> {
  const runtime = params.runtime ?? defaultRuntime;
  if (!params.configSnapshot.valid) {
    const invalid = buildInvalidConfigPostCoreUpdateResult();
    if (!params.json) {
      runtime.log(theme.error(invalid.message));
      for (const line of invalid.guidance) {
        runtime.log(theme.muted(`  ${line}`));
      }
    }
    return invalid.result;
  }

  const clawHubTrustNotices = new Set<string>();
  const loggedPluginWarnings = new Set<string>();
  const pluginLogger = {
    ...(params.json ? { terminalLinks: false } : {}),
    info: (msg: string) => {
      if (!params.json) {
        runtime.log(msg);
      }
    },
    warn: (msg: string) => {
      const plain = stripAnsi(msg);
      if (
        plain.includes("ClawHub Security Audit") &&
        (params.json || plain.includes("Outcome: Review"))
      ) {
        clawHubTrustNotices.add(plain);
      }
      if (
        !params.json &&
        plain.includes("ClawHub") &&
        plain.includes("╭─") &&
        !loggedPluginWarnings.has(plain)
      ) {
        runtime.log(formatPluginUpdateWarning(msg));
        loggedPluginWarnings.add(plain);
      }
    },
  };

  if (!params.json) {
    runtime.log("");
    runtime.log(theme.heading("Updating plugins..."));
  }

  let warnings: PluginUpdateWarning[] = [];
  const capabilityConsent = params.onCapabilityConsent
    ? { onCapabilityConsent: params.onCapabilityConsent }
    : resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: params.acceptCapabilities,
        action: "update",
        allowPrompt: !params.json,
        runtime,
      });
  const pluginInstallRecords =
    params.pluginInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  const coreVersion = await readPackageVersion(params.root);
  const pluginUpdateChannel = resolveRegistryUpdateChannel({
    configChannel: params.channel,
    currentVersion: coreVersion,
  });
  const integrityDrifts: PostCorePluginUpdateResult["integrityDrifts"] = [];
  const pluginUpdateOutcomes: PluginUpdateOutcome[] = [];
  const collectPluginOutcome = (outcome: PluginUpdateOutcome) => {
    if (outcome.status !== "error" && !isActionableSkippedPostUpdateOutcome(outcome)) {
      pluginUpdateOutcomes.push(outcome);
      return;
    }
    const includeWarningInReason =
      params.json || !outcome.warning || !loggedPluginWarnings.has(stripAnsi(outcome.warning));
    const warning = createPluginUpdateWarning({
      ...(outcome.pluginId && outcome.pluginId !== "unknown" ? { pluginId: outcome.pluginId } : {}),
      reason:
        outcome.warning && includeWarningInReason
          ? `${outcome.warning}\n${outcome.message}`
          : outcome.message,
    });
    pluginUpdateOutcomes.push(outcome);
    warnings.push(warning);
  };
  const collectMissingPayloadOutcome = (entry: MissingPluginInstallPayload) => {
    const warning = createPluginUpdateWarning({
      pluginId: entry.pluginId,
      reason: `Plugin install payload missing after update: ${formatMissingPluginPayloadReason(entry)}.`,
      kind: "load",
    });
    warnings.push(warning);
    pluginUpdateOutcomes.push({
      pluginId: entry.pluginId,
      status: "error",
      message: warning.message,
    });
    return warning;
  };

  const onPluginIntegrityDrift = async (drift: PluginUpdateIntegrityDriftParams) => {
    integrityDrifts.push({
      pluginId: drift.pluginId,
      spec: drift.spec,
      expectedIntegrity: drift.expectedIntegrity,
      actualIntegrity: drift.actualIntegrity,
      ...(drift.resolvedSpec ? { resolvedSpec: drift.resolvedSpec } : {}),
      ...(drift.resolvedVersion ? { resolvedVersion: drift.resolvedVersion } : {}),
      action: "aborted",
    });
    return false;
  };

  const cohort = await convergePluginReleaseCohort({
    config: withPluginInstallRecords(params.configSnapshot.sourceConfig, pluginInstallRecords),
    channel: pluginUpdateChannel,
    coreVersion: coreVersion ?? undefined,
    versionBoundPluginIds: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
    timeoutMs: params.timeoutMs,
    workspaceDir: params.root,
    externalizedBundledPluginBridges: await listPersistedBundledPluginLocationBridges({
      workspaceDir: params.root,
    }),
    logger: pluginLogger,
    onIntegrityDrift: onPluginIntegrityDrift,
    ...capabilityConsent,
  });
  for (const error of cohort.sync.summary.errors) {
    collectPluginOutcome({ ...error, status: "error" });
  }
  let pluginConfig = cohort.config;
  let pluginsChanged = cohort.changed || params.configChanged === true;
  for (const entry of cohort.missingPayloads) {
    collectMissingPayloadOutcome(entry);
  }
  pluginUpdateOutcomes.push(...cohort.repairOutcomes);
  for (const rawOutcome of cohort.updateOutcomes) {
    collectPluginOutcome(rawOutcome);
  }

  for (const entry of cohort.remainingMissingPayloads) {
    if (!cohort.repairedMissingPayloadIds.has(entry.pluginId)) {
      collectMissingPayloadOutcome(entry);
    }
  }

  // Convergence checks activation before restart. Seed it from the current
  // sync/npm records so repair cannot overwrite them with an older disk snapshot.
  const convergenceBaselineRecords = pluginConfig.plugins?.installs ?? {};
  // Keep the observed records stable if convergence replaces them.
  const probedNpmRecords = new Map(
    cohort.updateOutcomes.map(({ pluginId }) => {
      const record = convergenceBaselineRecords[pluginId];
      return [pluginId, record?.source === "npm" ? { ...record } : undefined];
    }),
  );
  const convergence = await runPostCorePluginConvergence({
    cfg: pluginConfig,
    env: process.env,
    compatibilityHostVersion: coreVersion ?? undefined,
    baselineInstallRecords: convergenceBaselineRecords,
    beforePersistentEffect: params.beforePersistentEffect,
    ...capabilityConsent,
  });
  const repairedPluginIds = new Set([
    ...[...cohort.repairOutcomes, ...cohort.updateOutcomes]
      .filter((outcome) => outcome.status === "updated" || outcome.status === "unchanged")
      .map((outcome) => outcome.pluginId),
    ...(convergence.repairedPluginIds ?? []),
  ]);
  warnings = warnings.filter(
    (warning) => !warning.pluginId || !repairedPluginIds.has(warning.pluginId),
  );
  for (const pluginId of convergence.repairedPluginIds ?? []) {
    const before = convergenceBaselineRecords[pluginId];
    const after = convergence.installRecords[pluginId];
    pluginUpdateOutcomes.push({
      pluginId,
      status: "updated",
      currentVersion: before?.resolvedVersion ?? before?.version,
      nextVersion: after?.resolvedVersion ?? after?.version,
      message: `Repaired plugin "${pluginId}".`,
    });
  }
  for (const change of convergence.changes) {
    if (!params.json) {
      runtime.log(theme.muted(change));
    }
  }
  const convergenceWarnings = convergence.warnings.map((warning) =>
    createPluginUpdateWarning({
      ...warning,
      kind: warning.kind === "repair" ? "update" : warning.kind,
    }),
  );
  const convergenceOutcomes: PluginUpdateOutcome[] = [
    ...(convergence.outcomes ?? []),
    ...convergence.warnings.flatMap((warning): PluginUpdateOutcome[] =>
      warning.pluginId
        ? [{ pluginId: warning.pluginId, status: "error", message: warning.message }]
        : [],
    ),
  ];
  for (const warning of [...convergenceWarnings, ...(convergence.notices ?? [])]) {
    warnings.push(warning);
  }
  for (const outcome of convergenceOutcomes) {
    pluginUpdateOutcomes.push(outcome);
    if (outcome.status === "error" || isActionableSkippedPostUpdateOutcome(outcome)) {
      const warning = createPluginUpdateWarning({
        pluginId: outcome.pluginId,
        reason: outcome.message,
      });
      if (!warnings.some((entry) => entry.pluginId === warning.pluginId)) {
        warnings.push(warning);
      }
    }
  }
  // Repair already persisted this authoritative map; the commit below must not
  // restore the pre-convergence records and discard successful repairs.
  pluginConfig = withPluginInstallRecords(pluginConfig, convergence.installRecords);
  // Report retention only while the probed install survives convergence.
  for (const outcome of cohort.updateOutcomes) {
    const record = convergence.installRecords[outcome.pluginId];
    const probed = probedNpmRecords.get(outcome.pluginId);
    if (
      outcome.status !== "unchanged" ||
      !outcome.currentVersion ||
      record?.source !== "npm" ||
      record.spec !== probed?.spec
    ) {
      continue;
    }
    const unavailable = outcome.code === "plugin-target-unavailable";
    if (
      unavailable
        ? record.installPath !== probed?.installPath ||
          record.version !== probed?.version ||
          record.resolvedVersion !== probed?.resolvedVersion
        : !outcome.nextVersion ||
          comparePackageUpdateVersions(outcome.nextVersion, outcome.currentVersion) <= 0 ||
          (record.resolvedVersion ?? record.version) !== outcome.currentVersion ||
          resolveExactNpmSpecVersion(record.spec) !== outcome.currentVersion ||
          !isTrustedOfficialPluginInstallRecord({
            pluginId: outcome.pluginId,
            packageName: resolveNpmSpecPackageName(record.spec),
            record,
          })
    ) {
      continue;
    }
    const message = unavailable
      ? outcome.message
      : `Plugin update retained an official plugin pin: ${outcome.message}`;
    warnings.push({
      pluginId: outcome.pluginId,
      reason: unavailable ? "plugin-target-unavailable" : "retained-plugin-pin",
      message,
      guidance: unavailable
        ? [formatCliCommand(`openclaw plugins update ${outcome.pluginId}`)]
        : ["Keep the pin if intentional; replacing it is an explicit operator choice."],
    });
    if (unavailable) {
      getLogger().warn(message);
    }
  }
  if (convergence.changes.length > 0) {
    pluginsChanged = true;
  }

  if (pluginsChanged) {
    const nextInstallRecords = pluginConfig.plugins?.installs ?? {};
    let nextConfig = withoutPluginInstallRecords(pluginConfig);
    if (params.restoredAuthoredChannels !== undefined) {
      nextConfig = {
        ...nextConfig,
        channels: structuredClone(params.restoredAuthoredChannels) as OpenClawConfig["channels"],
      };
    }
    // Installed plugin metadata can own migrations that this process has not loaded yet.
    // Finalization runs fresh doctor plus strict validation before the update can complete.
    await commitPluginInstallRecordsWithConfig({
      beforePersistentEffect: params.beforePersistentEffect,
      previousInstallRecords: pluginInstallRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: params.configSnapshot.hash,
      writeOptions: {
        ...params.configWriteOptions,
        inputBase: "source",
        skipPluginValidation: true,
      },
    });
    await params.beforePersistentEffect?.();
    await refreshPluginRegistryAfterConfigMutation({
      configPath: params.configSnapshot.path,
      reason: "source-changed",
      workspaceDir: params.root,
      installRecords: nextInstallRecords,
      invalidateRuntimeCache: false,
      logger: pluginLogger,
    });
  }

  for (const notice of clawHubTrustNotices) {
    if (warnings.some((warning) => warning.reason.includes(notice))) {
      continue;
    }
    warnings.push({
      reason: notice,
      message: notice,
      guidance: [],
    });
  }

  const finalPluginOutcomes = [
    ...new Map(pluginUpdateOutcomes.map((outcome) => [outcome.pluginId, outcome])).values(),
  ];
  const status =
    warnings.length > 0 || finalPluginOutcomes.some((outcome) => outcome.status === "error")
      ? "warning"
      : "ok";
  const result: PostCorePluginUpdateResult = {
    status,
    changed: pluginsChanged,
    warnings,
    sync: {
      changed: cohort.sync.changed,
      switchedToBundled: cohort.sync.summary.switchedToBundled,
      switchedToNpm: cohort.sync.summary.switchedToNpm,
      warnings: cohort.sync.summary.warnings,
      errors: cohort.sync.summary.errors.map((error) => error.message),
    },
    npm: {
      changed: cohort.npmChanged,
      outcomes: pluginUpdateOutcomes,
    },
    integrityDrifts,
  };

  if (params.json) {
    return result;
  }

  const summarizeList = (list: string[]) => {
    if (list.length <= 6) {
      return list.join(", ");
    }
    return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
  };

  if (cohort.sync.summary.switchedToBundled.length > 0) {
    runtime.log(
      theme.muted(
        `Switched to bundled plugins: ${summarizeList(cohort.sync.summary.switchedToBundled)}.`,
      ),
    );
  }
  if (cohort.sync.summary.switchedToNpm.length > 0) {
    runtime.log(
      theme.muted(`Restored plugins: ${summarizeList(cohort.sync.summary.switchedToNpm)}.`),
    );
  }
  for (const warning of cohort.sync.summary.warnings) {
    if (!loggedPluginWarnings.has(stripAnsi(warning))) {
      runtime.log(formatPluginUpdateWarning(warning));
      loggedPluginWarnings.add(stripAnsi(warning));
    }
  }
  const updated = finalPluginOutcomes.filter((entry) => entry.status === "updated").length;
  const unchanged = finalPluginOutcomes.filter((entry) => entry.status === "unchanged").length;
  const failed = finalPluginOutcomes.filter((entry) => entry.status === "error").length;
  const skipped = finalPluginOutcomes.filter((entry) => entry.status === "skipped").length;

  if (pluginUpdateOutcomes.length === 0 && warnings.length === 0) {
    runtime.log(theme.muted("No plugin updates needed."));
  } else if (pluginUpdateOutcomes.length > 0) {
    const parts = [`${updated} updated`, `${unchanged} unchanged`];
    if (failed > 0) {
      parts.push(`${failed} to retry`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} skipped`);
    }
    runtime.log(theme.muted(`Plugin updates: ${parts.join(", ")}.`));
  }

  for (const message of collectPluginChannelFallbackMessages(pluginUpdateOutcomes)) {
    runtime.log(theme.warn(message));
  }

  for (const warning of warnings) {
    const message = stripAnsi(warning.message);
    if (!loggedPluginWarnings.has(message)) {
      runtime.log(formatPluginUpdateWarning(warning.message));
      loggedPluginWarnings.add(message);
    }
  }

  return result;
}
