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
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { selectUtilityModel } from "../agents/utility-model-selection.js";
import { readUtilityModelSetting } from "../agents/utility-model-setting.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolvePluginSetupCliBackend } from "../plugins/setup-registry.js";
import type { CliBackendPlugin } from "../plugins/types.js";

/** Known descriptor and role-policy mismatches; model quality and live availability remain runtime facts. */
export function collectUtilityModelWarnings(
  config: OpenClawConfig,
  loadMetadata: () => Pick<PluginMetadataSnapshot, "plugins"> &
    Partial<Pick<PluginMetadataSnapshot, "owners">> = () =>
    loadManifestMetadataSnapshot({ config }),
): ConfigValidationIssue[] {
  const restrictedRoles = Object.entries(config.gateway?.roles?.definitions ?? {}).filter(
    ([, role]) => role.modelPolicy,
  );
  if (
    restrictedRoles.length === 0 &&
    config.agents?.defaults?.utilityModel === undefined &&
    !Object.values(config.agents?.entries ?? {}).some((agent) => agent.utilityModel !== undefined)
  ) {
    return [];
  }
  const warnings = new Map<string, ConfigValidationIssue>();
  let metadata: ReturnType<typeof loadMetadata> | undefined;
  // This synchronous validation owns one config and inventory; discard both hits
  // and misses afterward so the next config generation resolves fresh owners.
  const backends = new Map<string, CliBackendPlugin | undefined>();
  const resolveBackend = (id: string) => {
    const normalized = normalizeProviderId(id);
    if (backends.has(normalized)) {
      return backends.get(normalized);
    }
    const backend =
      resolveRuntimeCliBackends().find((entry) => normalizeProviderId(entry.id) === normalized) ??
      resolvePluginSetupCliBackend({ backend: normalized, config })?.backend;
    backends.set(normalized, backend);
    return backend;
  };
  const manifest = () => {
    metadata ??= loadMetadata();
    return metadata.owners ? { owners: metadata.owners } : metadata.plugins;
  };
  withAgentRosterFactsBatch(config, () => {
    // One prepared policy per role; the role, not the agent, defines it.
    const rolePolicies = restrictedRoles.map(([name, role]) => ({
      name,
      agents: role.agents,
      policy: prepareOperatorModelPolicy({
        cfg: config,
        policy: role.modelPolicy,
        manifestPlugins: manifest(),
      }),
    }));
    for (const agentId of listAgentIds(config)) {
      const utility = readUtilityModelSetting(config, agentId);
      if (utility.kind === "disabled") {
        continue;
      }
      for (const { name, agents, policy } of rolePolicies) {
        if (agents !== "*" && !agents.includes(agentId)) {
          continue;
        }
        const selection = selectUtilityModel({
          cfg: config,
          agentId,
          metadataSnapshot: metadata,
          // Configuration facts only: live inventory stays unknown here.
          catalog: { entries: [], authoritative: false },
          modelPolicy: policy,
        });
        if ("disabled" in selection && selection.disabled === "role-policy") {
          const path = `gateway.roles.definitions.${name}.modelPolicy`;
          const message = `Role "${name}" allows no utility model for agent "${agentId}", so Activity recaps are off for sessions this role owns. Allow a utility model in this role's modelPolicy, or set a utilityModel the role allows.`;
          warnings.set(`${path}:${message}`, { path, message });
        }
      }
      const candidates =
        utility.kind === "explicit" ? [utility.modelRef, ...utility.fallbacks] : utility.fallbacks;
      if (candidates.length === 0) {
        continue;
      }
      const manifestPlugins = manifest();
      const defaultProvider =
        resolveDefaultModelForAgent({ cfg: config, agentId, manifestPlugins })?.provider ??
        DEFAULT_PROVIDER;
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
