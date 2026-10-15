import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { HealthFinding, HealthRepairEffect } from "../../../flows/health-checks.js";
import { resolvePluginInstallSources } from "../../../plugins/install-channel-specs.js";
import { resolveConfiguredPluginInstallContext } from "./missing-configured-plugin-install.candidates.js";
import {
  collectBlockedPluginIds,
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
} from "./missing-configured-plugin-install.ids.js";
import { resolveRecordInstallPath } from "./missing-configured-plugin-install.install.js";
import { resolveConfiguredPluginCandidateRepair } from "./missing-configured-plugin-install.targets.js";

const CONFIGURED_PLUGIN_INSTALLS_CHECK_ID = "core/doctor/configured-plugin-installs";

type ConfiguredPluginInstallHealthIssue =
  | {
      kind: "missing-install-record";
      pluginId: string;
      installSpec: string;
    }
  | {
      kind:
        | "missing-installed-payload"
        | "repairable-installed-plugin"
        | "stale-version-bound-runtime";
      pluginId: string;
      installPath?: string;
      installSpec?: string;
      installSource?: PluginInstallRecord["source"];
    }
  | {
      kind: "missing-required-dependencies";
      pluginId: string;
      installPath?: string;
      installSpec?: string;
      installSource?: PluginInstallRecord["source"];
      missingRequired: string[];
    }
  | {
      kind: "stale-channel-config-descriptor" | "deferred-package-manager-repair";
      pluginId: string;
      installPath?: string;
    };

function recordedInstallIdentity(record: PluginInstallRecord | undefined) {
  return {
    installSpec: record?.resolvedSpec ?? record?.spec,
    installSource: record?.source,
  };
}

/** Detect configured plugin installs that Doctor can repair without mutating package state. */
export async function detectConfiguredPluginInstallHealthIssues(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  baselineRecords?: Record<string, PluginInstallRecord>;
}): Promise<ConfiguredPluginInstallHealthIssue[]> {
  const env = params.env ?? process.env;
  const pluginIds = collectConfiguredPluginIds(params.cfg, env);
  const channelIds = collectConfiguredChannelIds(params.cfg, env);
  const blockedPluginIds = collectBlockedPluginIds(params.cfg);
  const context = await resolveConfiguredPluginInstallContext({
    cfg: params.cfg,
    env,
    configuredPluginIds: pluginIds,
    configuredChannelIds: channelIds,
    blockedPluginIds,
    baselineRecords: params.baselineRecords,
  });
  const {
    configuredPluginIdsWithStaleDescriptors: staleDescriptorPluginIds,
    records,
    installedPluginIdsWithRepairablePackageDiagnostics: repairablePackageDiagnosticPluginIds,
    installedPluginIdsWithStaleVersionBoundRuntimePackages: staleVersionBoundRuntimePluginIds,
    installedPluginMissingRequiredDependencies,
  } = context;
  const issues: ConfiguredPluginInstallHealthIssue[] = [];

  const { pluginIds: deferredPluginIds, repairPluginIds } = context.collectDeferredRepairs(records);
  for (const pluginId of repairPluginIds) {
    const installPath = resolveRecordInstallPath(records[pluginId], env);
    issues.push({
      kind: "deferred-package-manager-repair",
      pluginId,
      ...(installPath ? { installPath } : {}),
    });
  }

  for (const [pluginId] of context.collectRecordedRepairs(records, deferredPluginIds)) {
    const record = records[pluginId];
    const missingDependencies = installedPluginMissingRequiredDependencies.get(pluginId);
    if (missingDependencies) {
      issues.push({
        kind: "missing-required-dependencies",
        pluginId,
        installPath: resolveRecordInstallPath(record, env),
        ...recordedInstallIdentity(record),
        missingRequired: missingDependencies.missingRequired,
      });
      continue;
    }
    const kind = staleVersionBoundRuntimePluginIds.has(pluginId)
      ? "stale-version-bound-runtime"
      : repairablePackageDiagnosticPluginIds.has(pluginId)
        ? "repairable-installed-plugin"
        : staleDescriptorPluginIds.has(pluginId)
          ? "stale-channel-config-descriptor"
          : "missing-installed-payload";
    const installPath = resolveRecordInstallPath(record, env);
    issues.push({
      kind,
      pluginId,
      ...(installPath ? { installPath } : {}),
      ...(kind === "stale-channel-config-descriptor" ? {} : recordedInstallIdentity(record)),
    });
  }

  const reportedPluginIds = new Set(issues.map((issue) => issue.pluginId));
  for (const candidate of context.collectInstallCandidates(records, deferredPluginIds)) {
    if (reportedPluginIds.has(candidate.pluginId)) {
      continue;
    }
    const repair = resolveConfiguredPluginCandidateRepair({ candidate, records, env, context });
    if (!repair) {
      continue;
    }
    const record = records[candidate.pluginId];
    const installSpec = resolvePluginInstallSources(candidate)[0]?.spec;
    if (repair.shouldReplaceBrokenOfficialInstall || record) {
      const installPath = resolveRecordInstallPath(record, env);
      issues.push({
        kind: repair.shouldReplaceBrokenOfficialInstall
          ? staleVersionBoundRuntimePluginIds.has(candidate.pluginId)
            ? "stale-version-bound-runtime"
            : "repairable-installed-plugin"
          : "missing-installed-payload",
        pluginId: candidate.pluginId,
        ...(installPath ? { installPath } : {}),
        ...recordedInstallIdentity(record),
      });
    } else if (installSpec) {
      issues.push({
        kind: "missing-install-record",
        pluginId: candidate.pluginId,
        installSpec,
      });
    }
  }

  return issues.toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

const CONFIGURED_PLUGIN_INSTALL_ISSUE_DETAILS = {
  "missing-install-record": {
    message: "is not installed.",
    fixHint: "",
    action: "would-install-configured-plugin",
  },
  "missing-installed-payload": {
    message: "has an install record but its package payload is missing.",
    fixHint: null,
    action: "would-reinstall-configured-plugin",
  },
  "missing-required-dependencies": {
    message: "is missing required dependencies:",
    fixHint: null,
    action: "would-repair-configured-plugin-dependencies",
  },
  "repairable-installed-plugin": {
    message: "has a repairable package install problem.",
    fixHint: null,
    action: "would-repair-configured-plugin-install",
  },
  "stale-version-bound-runtime": {
    message: "is older than this OpenClaw version.",
    fixHint: "Run `openclaw doctor --fix` to refresh the configured runtime plugin.",
    action: "would-refresh-configured-runtime-plugin",
  },
  "stale-channel-config-descriptor": {
    message: "has stale channel config metadata.",
    fixHint: "Run `openclaw doctor --fix` to repair the configured plugin install metadata.",
    action: "would-repair-configured-plugin-install",
  },
  "deferred-package-manager-repair": {
    message: "package repair is deferred until the package update finishes.",
    fixHint: "Rerun `openclaw doctor --fix` after the package update completes.",
    action: "would-defer-configured-plugin-install-repair",
  },
} as const;

export function configuredPluginInstallIssueToHealthFinding(
  issue: ConfiguredPluginInstallHealthIssue,
): HealthFinding {
  const detail = CONFIGURED_PLUGIN_INSTALL_ISSUE_DETAILS[issue.kind];
  const installSpec = "installSpec" in issue ? issue.installSpec : undefined;
  const subject = issue.kind === "stale-version-bound-runtime" ? "runtime plugin" : "plugin";
  const message = `Configured ${subject} ${issue.pluginId} ${detail.message}`;
  return {
    checkId: CONFIGURED_PLUGIN_INSTALLS_CHECK_ID,
    severity: "warning",
    message:
      issue.kind === "missing-required-dependencies"
        ? `${message} ${issue.missingRequired.join(", ")}.`
        : message,
    target: issue.pluginId,
    ...("installSource" in issue ? { source: issue.installSource } : {}),
    ...("installPath" in issue && issue.installPath ? { path: issue.installPath } : {}),
    fixHint:
      issue.kind === "missing-install-record"
        ? `Run \`openclaw doctor --fix\` to install ${issue.installSpec}.`
        : (detail.fixHint ??
          (installSpec
            ? `Run \`openclaw plugins install ${installSpec} --force\` to reinstall the configured plugin package.`
            : "Run `openclaw doctor --fix` to repair the configured plugin install. An exact reinstall command is unavailable because the install record has no package spec.")),
  };
}

export function configuredPluginInstallIssueToRepairEffect(
  issue: ConfiguredPluginInstallHealthIssue,
): HealthRepairEffect {
  const detail = CONFIGURED_PLUGIN_INSTALL_ISSUE_DETAILS[issue.kind];
  return {
    kind: "package",
    action: detail.action,
    target: issue.pluginId,
    dryRunSafe: issue.kind === "deferred-package-manager-repair",
  };
}
