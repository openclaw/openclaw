import type { ChannelDoctorConfigMutation } from "../channels/plugins/types.adapters.js";
import { applyHistoricalWebhookPins } from "../commands/doctor/shared/legacy-webhook-pins.js";
import { bindProviderRenameAuthProfiles } from "../commands/doctor/shared/provider-rename-auth.js";
import {
  applyProviderRenames,
  planProviderRenames,
} from "../commands/doctor/shared/provider-rename.js";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  PluginDoctorHistoricalWebhookListener,
  PluginDoctorProviderRename,
  PluginDoctorCompatibilityNormalizer,
} from "./doctor-contract-module.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

/** Selection and order belong to callers; every hook transforms a private candidate. */
export function applyPluginDoctorCompatibilitySequence(
  config: OpenClawConfig,
  entries: Iterable<{
    pluginId: string;
    normalizeCompatibilityConfig?: PluginDoctorCompatibilityNormalizer;
    transform?: (
      mutation: ReturnType<PluginDoctorCompatibilityNormalizer>,
    ) => ReturnType<PluginDoctorCompatibilityNormalizer>;
  }>,
): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  let next = config;
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const { pluginId, normalizeCompatibilityConfig, transform } of entries) {
    if (!normalizeCompatibilityConfig) {
      continue;
    }
    const candidate = cloneConfigWithResolutionFacts(next);
    try {
      const normalized = normalizeCompatibilityConfig({ cfg: candidate });
      // Follow-on repairs must not publish edits the hook declined to report.
      const reported = {
        ...normalized,
        config: normalized?.changes.length ? normalized.config : next,
        changes: normalized?.changes ?? [],
      };
      const mutation = transform ? transform(reported) : reported;
      if (mutation?.changes.length) {
        next = mutation.config;
        changes.push(...mutation.changes);
      }
      warnings.push(...(mutation?.warnings ?? []));
    } catch (error) {
      warnings.push(
        `Plugin "${pluginId}" config repair failed: ${formatErrorMessage(error)}. Its config was preserved; run \`openclaw doctor --fix\` after repairing the plugin.`,
      );
    }
  }
  return { config: next, changes, ...(warnings.length ? { warnings } : {}) };
}

type CompatibilityEntry = {
  pluginId: string;
  origin?: PluginOrigin;
  rules: readonly LegacyConfigRule[];
  providerRenames: readonly PluginDoctorProviderRename[];
  normalizeCompatibilityConfig?: PluginDoctorCompatibilityNormalizer;
  historicalWebhookListener?: PluginDoctorHistoricalWebhookListener;
  historicalWebhookNormalizer?: PluginDoctorCompatibilityNormalizer;
};

export type PluginDoctorCompatibilityResult = {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
};

/** Compose owner-selected repairs without making the registry own their execution policy. */
export function applyResolvedPluginDoctorCompatibilityMigrations(
  cfg: OpenClawConfig,
  entries: readonly CompatibilityEntry[],
  params: {
    env?: NodeJS.ProcessEnv;
    startup?: boolean;
    historicalWebhookListeners?: boolean;
    onInspectedPlugin?: (pluginId: string, hasConfigRepair: boolean) => void;
    isDeferred: (pluginId: string) => boolean;
  },
): PluginDoctorCompatibilityResult {
  const initialized = params.historicalWebhookListeners
    ? applyHistoricalWebhookPins({ config: cfg, changes: [] }, undefined, params)
    : { config: cfg, changes: [] };
  const result = applyPluginDoctorCompatibilitySequence(
    initialized.config,
    entries.map((entry) => {
      if (!params.isDeferred(entry.pluginId)) {
        params.onInspectedPlugin?.(
          entry.pluginId,
          entry.rules.length > 0 ||
            Boolean(entry.normalizeCompatibilityConfig) ||
            entry.providerRenames.length > 0,
        );
      }
      return {
        pluginId: entry.pluginId,
        normalizeCompatibilityConfig: entry.providerRenames.length
          ? ({ cfg }: { cfg: OpenClawConfig }) => {
              // Move the provider before plugin-local legacy auth-marker cleanup.
              const active = planProviderRenames(cfg, entry.providerRenames);
              const renamed = applyProviderRenames(
                cfg,
                bindProviderRenameAuthProfiles(cfg, active, params.env),
              );
              const normalized = entry.normalizeCompatibilityConfig?.({
                cfg: cloneConfigWithResolutionFacts(renamed.config),
              });
              return normalized
                ? {
                    ...normalized,
                    config: normalized.changes.length ? normalized.config : renamed.config,
                    changes: [...renamed.changes, ...normalized.changes],
                  }
                : renamed;
            }
          : entry.normalizeCompatibilityConfig,
        transform: params.historicalWebhookListeners
          ? (mutation: ChannelDoctorConfigMutation) => {
              if (entry.historicalWebhookNormalizer) {
                mutation.historicalWebhookAccountIds = entry.historicalWebhookNormalizer({
                  cfg: cloneConfigWithResolutionFacts(mutation.config),
                }).historicalWebhookAccountIds;
              }
              return applyHistoricalWebhookPins(mutation, entry.historicalWebhookListener, {
                ...params,
                pluginId: entry.pluginId,
                origin: entry.origin,
              });
            }
          : undefined,
      };
    }),
  );
  return { ...result, changes: [...initialized.changes, ...result.changes] };
}
