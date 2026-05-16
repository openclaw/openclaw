import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";

export type PluginInstallUpdate = PluginInstallRecord & { pluginId: string };

const CLAWHUB_TRUST_INSTALL_RECORD_FIELDS = [
  "clawhubTrustDisposition",
  "clawhubTrustScanStatus",
  "clawhubTrustModerationState",
  "clawhubTrustReasons",
  "clawhubTrustPending",
  "clawhubTrustStale",
  "clawhubTrustCheckedAt",
  "clawhubTrustAcknowledgedAt",
] as const satisfies readonly (keyof PluginInstallRecord)[];

export function buildNpmResolutionInstallFields(
  resolution?: NpmSpecResolution,
): Pick<
  PluginInstallRecord,
  "resolvedName" | "resolvedVersion" | "resolvedSpec" | "integrity" | "shasum" | "resolvedAt"
> {
  return buildNpmResolutionFields(resolution);
}

export function recordPluginInstall(
  cfg: OpenClawConfig,
  update: PluginInstallUpdate,
): OpenClawConfig {
  const { pluginId, ...record } = update;
  const previous = clearStaleInstallRecordFields(cfg.plugins?.installs?.[pluginId]);
  const installs = {
    ...cfg.plugins?.installs,
    [pluginId]: {
      ...previous,
      ...record,
      installedAt: record.installedAt ?? new Date().toISOString(),
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      installs: {
        ...installs,
        [pluginId]: installs[pluginId],
      },
    },
  };
}

function clearStaleInstallRecordFields(record: PluginInstallRecord | undefined) {
  if (!record) {
    return undefined;
  }
  const next: PluginInstallRecord = { ...record };
  for (const field of CLAWHUB_TRUST_INSTALL_RECORD_FIELDS) {
    delete next[field];
  }
  return next;
}
