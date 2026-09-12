// Boot-local plugin payload verification without repair or install operations.
import {
  createPluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveSourceCheckoutBundledPluginIds } from "./bundled-sources.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";
import {
  runPluginPayloadSmokeCheck,
  type PluginPayloadSmokeResult,
} from "./payload-verification.js";

/** Runs the static payload check without repair, installs, or network access. */
export async function runActivePluginPayloadSmokeCheck(params: {
  cfg: OpenClawConfig;
  records: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
}): Promise<PluginPayloadSmokeResult> {
  return await runPluginPayloadSmokeCheck({
    records: filterRecordsToActive(params),
    env: params.env,
  });
}

/** Selects the installed records covered by update/startup payload verification. */
export function filterRecordsToActive(params: {
  cfg: OpenClawConfig;
  records: Record<string, PluginInstallRecord>;
  env?: NodeJS.ProcessEnv;
}): Record<string, PluginInstallRecord> {
  const env = params.env ?? process.env;
  const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
  const sourceBundledIds = resolveSourceCheckoutBundledPluginIds({
    config: params.cfg,
    installRecords: params.records,
    env,
  });
  const filtered = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const [pluginId, record] of Object.entries(params.records)) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (sourceBundledIds.has(pluginId)) {
      // A dormant registry generation must not quarantine the selected source-built plugin.
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: "global",
      config: normalizedPluginConfig,
      rootConfig: params.cfg,
    });
    if (enableState.enabled) {
      setPluginInstallRecordMapEntry(filtered, pluginId, record);
      continue;
    }
    // Trusted-source-linked official installs remain authoritative sync targets
    // even when their plugin entry is disabled.
    const officialNpm = resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId, record });
    const officialClawHub = resolveTrustedSourceLinkedOfficialClawHubSpec({ pluginId, record });
    if (officialNpm || officialClawHub) {
      setPluginInstallRecordMapEntry(filtered, pluginId, record);
    }
  }
  return filtered;
}
