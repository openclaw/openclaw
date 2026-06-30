// Normalizes installed plugin config and install records.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";

/** Plugin install record update with the target plugin id attached. */
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

/** Builds install record fields from resolved npm package metadata. */
export function buildNpmResolutionInstallFields(
  resolution?: NpmSpecResolution,
): Pick<
  PluginInstallRecord,
  "resolvedName" | "resolvedVersion" | "resolvedSpec" | "integrity" | "shasum" | "resolvedAt"
> {
  return buildNpmResolutionFields(resolution);
}

function isExactRegistryNpmSpec(spec: string | undefined): spec is string {
  const parsed = spec ? parseRegistryNpmSpec(spec) : null;
  return parsed?.selectorKind === "exact-version";
}

export function resolveNpmInstallRecordSpec(params: {
  requestedSpec?: string;
  resolution?: NpmSpecResolution;
  pinResolvedRegistrySpec?: boolean;
}): string | undefined {
  const resolvedSpec = params.resolution?.resolvedSpec;
  if (!params.pinResolvedRegistrySpec || !isExactRegistryNpmSpec(resolvedSpec)) {
    return params.requestedSpec;
  }
  return resolvedSpec;
}

/**
 * Generates a unique key for install records that supports multiple installs
 * of the same plugin to different agents.
 * Format: pluginId (for global) or pluginId:agentId (for agent-specific)
 */
function buildInstallRecordKey(pluginId: string, agentId?: string): string {
  if (agentId === undefined || agentId === "") {
    return pluginId;
  }
  return `${pluginId}:${agentId}`;
}

/**
 * Extracts the original pluginId from an install record key.
 * Keys can be "pluginId" (global) or "pluginId:agentId" (agent-specific).
 */
export function extractPluginIdFromKey(key: string): string {
  const colonIndex = key.indexOf(":");
  if (colonIndex === -1) {
    return key;
  }
  return key.substring(0, colonIndex);
}

/** Records or updates a plugin install record in OpenClaw config. */
export function recordPluginInstall(
  cfg: OpenClawConfig,
  update: PluginInstallUpdate,
): OpenClawConfig {
  const { pluginId, agentId, ...record } = update;
  const installs = { ...cfg.plugins?.installs };

  // Find an existing record for this specific pluginId + agentId combination
  let existingKey: string | undefined;
  for (const [key, existingRecord] of Object.entries(installs)) {
    const recordPluginId = extractPluginIdFromKey(key);
    if (recordPluginId === pluginId && existingRecord.agentId === agentId) {
      existingKey = key;
      break;
    }
  }

  const newKey = existingKey ?? buildInstallRecordKey(pluginId, agentId);
  const previous = clearStaleInstallRecordFields(installs[newKey]);

  installs[newKey] = {
    ...previous,
    ...record,
    ...(agentId ? { agentId } : {}),
    installedAt: record.installedAt ?? new Date().toISOString(),
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      installs,
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
