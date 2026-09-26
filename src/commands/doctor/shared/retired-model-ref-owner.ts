import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntime } from "../../../agents/auth-profiles/store-runtime.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { createModelAuthAvailabilityResolver } from "../../../agents/model-auth-availability.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../../agents/model-selection-shared.js";
import { resolvePluginModelCatalogOwnerPluginId } from "../../../agents/plugin-model-catalog.js";
import { canonicalizeProviderModelId } from "../../../agents/provider-model-route.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizePluginsConfig } from "../../../plugins/config-state.js";
import { createInstalledPluginEnabledPredicate } from "../../../plugins/installed-plugin-index.js";
import {
  loadManifestMetadataSnapshot,
  isManifestPluginAvailableForControlPlane,
} from "../../../plugins/manifest-contract-eligibility.js";
import { buildManifestBuiltInModelSuppressionResolver } from "../../../plugins/manifest-model-suppression.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import type { ModelRetirementScope } from "./retired-model-ref-repair.types.js";
import { projectRetiredModelSuccessorConfig } from "./retired-model-ref-settings.js";

export function createRetiredModelRefOwners(params: {
  cfg: OpenClawConfig;
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  agentIds?: readonly string[];
  checkModelPolicy?: boolean;
}) {
  const env = params.env ?? process.env;
  const agents = params.agentIds ?? listAgentIds(params.cfg);
  const normalizedPluginsConfig = normalizePluginsConfig(params.cfg.plugins);
  const owners = new Map(
    agents.map((agentId) => {
      const agentDir = resolveAgentDir(params.cfg, agentId, env);
      const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
      const metadataSnapshot =
        params.metadataSnapshot ??
        loadManifestMetadataSnapshot({ config: params.cfg, workspaceDir, env });
      const isInstalledPluginEnabled = createInstalledPluginEnabledPredicate(
        metadataSnapshot.index.plugins,
        params.cfg,
      );
      const authViews = new Map<
        OpenClawConfig,
        Map<string | undefined, ReturnType<typeof createModelAuthAvailabilityResolver>>
      >();
      const successorConfigs = new Map<string, OpenClawConfig>();
      const prepareModelResolver = (cfg: OpenClawConfig) => {
        const modelOptions = {
          cfg,
          agentId,
          manifestPlugins: metadataSnapshot.plugins,
          allowManifestNormalization: false,
          allowPluginNormalization: false,
        };
        const defaultRef = resolveConfiguredModelRef({
          ...modelOptions,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        });
        const defaultProvider = defaultRef.provider;
        const aliasIndex = buildModelAliasIndex({ ...modelOptions, defaultProvider });
        return {
          defaultRef,
          resolve: (raw: string) =>
            resolveModelRefFromString({ ...modelOptions, raw, defaultProvider, aliasIndex })?.ref,
        };
      };
      // Preserve old alias/default interpretation without lending it auth or route authority.
      const model = prepareModelResolver(params.retiredModelRefConfig ?? params.cfg);
      const currentModel = params.retiredModelRefConfig ? prepareModelResolver(params.cfg) : model;
      return [
        agentId,
        {
          nativeApiKeyRoute(provider: string) {
            const pluginId = resolvePluginModelCatalogOwnerPluginId({
              providerId: provider,
              pluginMetadataSnapshot: metadataSnapshot,
            });
            const plugin = metadataSnapshot.plugins.find(
              (candidate) =>
                candidate.id === pluginId &&
                isManifestPluginAvailableForControlPlane({
                  snapshot: metadataSnapshot,
                  plugin: candidate,
                  config: params.cfg,
                  normalizedConfig: normalizedPluginsConfig,
                  isInstalledPluginEnabled,
                }),
            );
            const catalog = Object.entries(plugin?.modelCatalog?.providers ?? {}).find(
              ([providerId]) => normalizeProviderId(providerId) === provider,
            )?.[1];
            return catalog?.baseUrl ? { api: catalog.api, baseUrl: catalog.baseUrl } : undefined;
          },
          model: model.resolve,
          currentModel: currentModel.resolve,
          modelPolicy: params.checkModelPolicy
            ? buildAllowedModelSet({
                cfg: params.cfg,
                catalog: [],
                agentId,
                defaultProvider: currentModel.defaultRef.provider,
                defaultModel: currentModel.defaultRef,
                manifestPlugins: metadataSnapshot.plugins,
              })
            : undefined,
          successorConfig(change: {
            sourceModelRef: string;
            successorModelRef: string;
            retirementScope: ModelRetirementScope;
          }) {
            const key = JSON.stringify(change);
            let config = successorConfigs.get(key);
            if (!config) {
              config = projectRetiredModelSuccessorConfig({
                cfg: params.cfg,
                agentId,
                ...change,
                resolveModelRef: (raw) => {
                  const ref = model.resolve(raw);
                  return ref
                    ? `${ref.provider}/${canonicalizeProviderModelId(ref.provider, ref.model)}`
                    : undefined;
                },
              });
              successorConfigs.set(key, config);
            }
            return config;
          },
          auth(profileId: string | undefined, config = params.cfg) {
            let views = authViews.get(config);
            if (!views) {
              views = new Map<
                string | undefined,
                ReturnType<typeof createModelAuthAvailabilityResolver>
              >();
              authViews.set(config, views);
            }
            let view = views.get(profileId);
            if (!view) {
              view = createModelAuthAvailabilityResolver({
                cfg: config,
                agentId,
                agentDir,
                workspaceDir,
                env,
                metadataSnapshot,
                authStore: loadAuthProfileStoreForSecretsRuntime(agentDir, {
                  config,
                  profileId,
                }),
              });
              views.set(profileId, view);
            }
            return view;
          },
          suppression(config = params.cfg) {
            return buildManifestBuiltInModelSuppressionResolver({
              config,
              workspaceDir,
              env,
              metadataSnapshot,
            });
          },
        },
      ];
    }),
  );
  return owners;
}
