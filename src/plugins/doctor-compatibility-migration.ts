import type { ChannelDoctorConfigMutation } from "../channels/plugins/types.adapters.js";
import { applyHistoricalWebhookPins } from "../commands/doctor/shared/legacy-webhook-pins.js";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  PluginDoctorCompatibilityNormalizer,
  PluginDoctorHistoricalWebhookListener,
  PluginDoctorProviderRename,
} from "./doctor-contract-module.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type PluginDoctorCompatibilityResult = {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
};

/** Selection and order belong to callers; every hook transforms a private candidate. */
export function applyPluginDoctorCompatibilitySequence(
  config: OpenClawConfig,
  entries: Iterable<{
    pluginId: string;
    normalizeCompatibilityConfig?: PluginDoctorCompatibilityNormalizer;
    transform?: (mutation: ChannelDoctorConfigMutation) => ChannelDoctorConfigMutation;
  }>,
): PluginDoctorCompatibilityResult {
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

/** Apply resolved declarations without coupling the compatibility owner to registry loading. */
export function applyResolvedPluginDoctorCompatibilityMigrations(
  cfg: OpenClawConfig,
  entries: readonly {
    pluginId: string;
    origin?: PluginOrigin;
    rules: readonly LegacyConfigRule[];
    providerRenames: readonly PluginDoctorProviderRename[];
    normalizeCompatibilityConfig?: PluginDoctorCompatibilityNormalizer;
    historicalWebhookListener?: PluginDoctorHistoricalWebhookListener;
    historicalWebhookNormalizer?: PluginDoctorCompatibilityNormalizer;
  }[],
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
        normalizeCompatibilityConfig: entry.normalizeCompatibilityConfig,
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
