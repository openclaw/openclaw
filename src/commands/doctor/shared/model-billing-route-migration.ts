import {
  collectConfiguredModelRefs,
  visitModelSelectorRefs,
} from "@openclaw/model-catalog-core/configured-model-refs";
import {
  listAgentEntries,
  listAgentIds,
  tryResolveSoleAgentId,
} from "../../../agents/agent-scope-config.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveSubagentModelConfigSelectionResult,
  resolveSubagentSpawnModelFallbacksOverride,
} from "../../../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntime } from "../../../agents/auth-profiles/store-runtime.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { createModelAuthAvailabilityResolver } from "../../../agents/model-auth-availability.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveHeartbeatAgents } from "../../../infra/heartbeat-config.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { sanitizeDoctorNote } from "../emit-notes.js";

type AuthStores = Map<string | undefined, ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>>;
type ModelConsumer = { path: string; value: string; agentId?: string; consumer?: string };

function collectModelConsumers(cfg: OpenClawConfig): ModelConsumer[] {
  const agents = listAgentEntries(cfg);
  const refs = collectConfiguredModelRefs(cfg).filter(
    ({ path, value }) => !path.startsWith("agents.") && !path.endsWith(`.models.${value}`),
  );
  const consumers: ModelConsumer[] = refs;
  const heartbeatAgents = new Map(
    resolveHeartbeatAgents(cfg).map((entry) => [entry.agentId, entry.heartbeat]),
  );
  for (const agentId of listAgentIds(cfg)) {
    const entry = agents.find((agent) => agent.id === agentId);
    const primary = resolveAgentEffectiveModelPrimary(cfg, agentId);
    const prefix = `agents.entries.${agentId}`;
    const add = (path: string, value: string, sourcePath = path) =>
      consumers.push({ path, value, agentId, consumer: `${sourcePath} (agent ${agentId})` });
    visitModelSelectorRefs(
      {
        primary,
        fallbacks:
          resolveAgentModelFallbacksOverride(cfg, agentId) ??
          (typeof cfg.agents?.defaults?.model === "object"
            ? cfg.agents.defaults.model.fallbacks
            : undefined),
      },
      `${prefix}.model`,
      (path, value) => add(path, value),
    );
    if (heartbeatAgents.has(agentId)) {
      const heartbeatModel = heartbeatAgents.get(agentId)?.model ?? primary;
      if (heartbeatModel) {
        add(
          `${prefix}.heartbeat.model`,
          heartbeatModel,
          entry?.heartbeat?.model ? `${prefix}.heartbeat.model` : "agents.defaults.heartbeat.model",
        );
      }
    }
    const subagent = resolveSubagentModelConfigSelectionResult({ cfg, agentId });
    visitModelSelectorRefs(
      subagent?.raw ?? cfg.agents?.defaults?.model,
      `${prefix}.subagents.model`,
      (path, value, role) => {
        if (role === "primary") {
          add(
            path,
            value,
            subagent?.source === "default-subagent"
              ? path.replace(prefix, "agents.defaults")
              : path,
          );
        }
      },
    );
    for (const [index, value] of (
      resolveSubagentSpawnModelFallbacksOverride(cfg, agentId) ?? []
    ).entries()) {
      add(`${prefix}.subagents.model.fallbacks.${index}`, value);
    }
    if (entry) {
      for (const ref of collectConfiguredModelRefs({ agents: { entries: { [agentId]: entry } } })) {
        if (
          !ref.path.endsWith(`.models.${ref.value}`) &&
          !ref.path.startsWith(`${prefix}.model`) &&
          ref.path !== `${prefix}.heartbeat.model` &&
          !ref.path.startsWith(`${prefix}.subagents.model`)
        ) {
          add(ref.path, ref.value);
        }
      }
    }
  }
  return consumers;
}

type BillingRoute = {
  modelRef: string;
  requirement: "api-key" | "subscription";
  profileId?: string;
  consumer: string;
};

function collectBillingRoutes(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  authStores: AuthStores;
}): Map<string, BillingRoute> {
  const { cfg, env, metadataSnapshot } = params;
  const owners = new Map<string | undefined, ReturnType<typeof prepareOwner>>();
  const prepareOwner = (agentId: string | undefined) => {
    const agentDir = agentId ? resolveAgentDir(cfg, agentId, env) : undefined;
    const workspaceDir = agentId ? resolveAgentWorkspaceDir(cfg, agentId, env) : undefined;
    let authStore = params.authStores.get(agentDir);
    if (!authStore) {
      authStore = loadAuthProfileStoreForSecretsRuntime(agentDir, {
        config: cfg,
        externalCli: { mode: "none" },
      });
      params.authStores.set(agentDir, authStore);
    }
    const options = {
      cfg,
      agentId,
      manifestPlugins: metadataSnapshot?.plugins,
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    };
    const defaultProvider = resolveConfiguredModelRef({
      ...options,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    }).provider;
    const aliasIndex = buildModelAliasIndex({ ...options, defaultProvider });
    return {
      resolve: (raw: string) =>
        resolveModelRefFromString({ ...options, raw, defaultProvider, aliasIndex })?.ref,
      auth: createModelAuthAvailabilityResolver({
        cfg,
        agentId,
        agentDir,
        workspaceDir,
        env,
        metadataSnapshot,
        externalCliProviderIds: [],
        authStore,
      }),
    };
  };
  const routes = new Map<string, BillingRoute>();
  for (const { path, value, consumer, agentId: consumerAgentId } of collectModelConsumers(cfg)) {
    const agentId = consumerAgentId ?? tryResolveSoleAgentId(cfg);
    let owner = owners.get(agentId);
    if (!owner) {
      owner = prepareOwner(agentId);
      owners.set(agentId, owner);
    }
    const parsed = splitTrailingAuthProfile(value);
    const model = owner.resolve(parsed.model);
    if (!model) {
      continue;
    }
    const auth = owner.auth.evaluateRuntimeModelAuth(model.provider, {
      modelId: model.model,
      pinnedProfileId: parsed.profile,
    });
    if (auth.availability !== true || !auth.selectedRoute) {
      continue;
    }
    routes.set(path, {
      consumer: consumer ?? path,
      modelRef: `${model.provider}/${model.model}`,
      requirement: auth.selectedRoute.authRequirement,
      profileId: auth.selectedProfileId,
    });
  }
  return routes;
}

/** Compare resolved billing facts; missing credentials are not evidence of a route change. */
export function collectModelBillingRouteMigrationWarnings(params: {
  before: OpenClawConfig;
  after: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): string[] {
  const options = {
    env: params.env ?? process.env,
    metadataSnapshot: params.metadataSnapshot,
    authStores: new Map<
      string | undefined,
      ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>
    >(),
  };
  const before = collectBillingRoutes({ ...options, cfg: params.before });
  const after = collectBillingRoutes({ ...options, cfg: params.after });
  const describe = (route: BillingRoute) =>
    `${route.modelRef} via ${route.requirement === "api-key" ? "metered API-key" : "subscription/OAuth"}${route.profileId ? ` profile ${route.profileId}` : ""}`;
  const warnings: string[] = [];
  for (const [consumer, previous] of before) {
    const current = after.get(consumer);
    if (current && current.requirement !== previous.requirement) {
      warnings.push(
        sanitizeDoctorNote(
          `Billing route changed for ${previous.consumer}: ${describe(previous)} -> ${describe(current)}. Review its model and authentication settings.`,
        ),
      );
    }
  }
  return warnings;
}
