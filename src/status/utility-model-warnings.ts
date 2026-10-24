import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  listAgentIds,
  resolveAgentEntry,
  withAgentRosterFactsBatch,
} from "../agents/agent-scope-config.js";
import {
  cliBackendSupportsExactToolAvailability,
  isCliRuntimeModelBackendForProvider,
  resolveCliRuntimeProfileAlias,
} from "../agents/cli-backends.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { readUtilityModelSetting } from "../agents/utility-model-setting.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolvePluginSetupCliBackend } from "../plugins/setup-registry.js";

/** Known descriptor mismatches only; model quality and live availability remain runtime facts. */
export function collectUtilityModelWarnings(
  config: OpenClawConfig,
  loadMetadata: () => Pick<PluginMetadataSnapshot, "plugins"> &
    Partial<Pick<PluginMetadataSnapshot, "owners">> = () =>
    loadManifestMetadataSnapshot({ config }),
): ConfigValidationIssue[] {
  if (
    config.agents?.defaults?.utilityModel === undefined &&
    !Object.values(config.agents?.entries ?? {}).some((agent) => agent.utilityModel !== undefined)
  ) {
    return [];
  }
  const warnings = new Map<string, ConfigValidationIssue>();
  let metadata: ReturnType<typeof loadMetadata> | undefined;
  const resolveBackend = (id: string) => {
    const normalized = normalizeProviderId(id);
    return (
      resolveRuntimeCliBackends().find(
        (backend) => normalizeProviderId(backend.id) === normalized,
      ) ?? resolvePluginSetupCliBackend({ backend: normalized, config })?.backend
    );
  };
  withAgentRosterFactsBatch(config, () => {
    for (const agentId of listAgentIds(config)) {
      const utility = readUtilityModelSetting(config, agentId);
      if (utility.kind === "disabled") {
        continue;
      }
      const candidates =
        utility.kind === "explicit" ? [utility.modelRef, ...utility.fallbacks] : utility.fallbacks;
      if (candidates.length === 0) {
        continue;
      }
      metadata ??= loadMetadata();
      const manifestPlugins = metadata.owners ? { owners: metadata.owners } : metadata.plugins;
      const defaultProvider = resolveDefaultModelForAgent({
        cfg: config,
        agentId,
        manifestPlugins,
      }).provider;
      const aliasIndex = buildModelAliasIndex({
        cfg: config,
        agentId,
        defaultProvider,
        manifestPlugins,
      });
      const agent = resolveAgentEntry(config, agentId);
      const path =
        agent?.utilityModel === undefined
          ? "agents.defaults.utilityModel"
          : `agents.entries.${agent.id}.utilityModel`;
      const profile =
        utility.kind === "explicit"
          ? splitTrailingAuthProfile(utility.modelRef).profile
          : undefined;
      let primaryProvider: string | undefined;
      for (const [index, raw] of candidates.entries()) {
        const resolved = resolveModelRefFromString({
          cfg: config,
          agentId,
          raw,
          defaultProvider,
          aliasIndex,
          manifestPlugins,
        });
        if (!resolved) {
          continue;
        }
        const { provider, model } = resolved.ref;
        if (utility.kind === "explicit" && index === 0) {
          primaryProvider = provider;
        }
        let runtime = resolveModelRuntimePolicy({
          config,
          agentId,
          provider,
          modelId: model,
        }).policy?.id?.trim();
        // Utility fallbacks retain the primary profile only within the same provider.
        if ((!runtime || runtime === "auto") && profile && provider === primaryProvider) {
          runtime = resolveCliRuntimeProfileAlias({
            cfg: config,
            metadataSnapshot: metadata,
            provider,
            profileProvider: config.auth?.profiles?.[profile]?.provider,
          });
        }
        const direct = resolveBackend(provider);
        // A CLI alias owns its canonical provider; otherwise respect a mapped runtime pin.
        const backend =
          direct?.modelProvider ||
          !isCliRuntimeModelBackendForProvider({ provider, runtime, config })
            ? direct
            : resolveBackend(runtime ?? "");
        if (!backend || cliBackendSupportsExactToolAvailability(backend)) {
          continue;
        }
        const message = `Utility model "${provider}/${model}" uses CLI backend "${backend.id}", which cannot enforce the tool-free utility contract. Choose a capable utility model or add capable utilityModel fallbacks; the explicit route is unchanged.`;
        warnings.set(`${path}:${message}`, { path, message });
      }
    }
  });
  return [...warnings.values()];
}
