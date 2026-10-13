import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import { supportsSetupTextInference } from "./setup-inference-auth-options.js";
import {
  throwIfSetupInferenceCancelled,
  type ActivateSetupInferenceParams,
  type ActivateSetupInferenceDeps,
  type StageFailure,
} from "./setup-inference-core.js";

export type SetupProviderAuthMethod = {
  config: OpenClawConfig;
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
};

/** Import under the mutation lease; keep provider callbacks owned through their materialization. */
export async function withSetupProviderAuthMethod<T>(
  params: {
    cfg: OpenClawConfig;
    workspace: string;
    choice: ProviderAuthChoiceMetadata;
    deps: Pick<ActivateSetupInferenceDeps, "resolvePluginProviders">;
    activation?: ActivateSetupInferenceParams;
    beforePersistentEffect?: () => Promise<void>;
    signal?: AbortSignal;
  },
  consume: (loaded: SetupProviderAuthMethod) => T | Promise<T>,
): Promise<T | StageFailure> {
  await using cache = createPluginCache();
  const activation = params.activation;
  const loaded = await withPluginLifecycleLease(
    { signal: params.signal ?? activation?.signal },
    async () =>
      withPluginCache(cache, async (): Promise<SetupProviderAuthMethod | StageFailure> => {
        const enabled = await enablePluginWithCapabilityConsent(
          params.cfg,
          params.choice.pluginId,
          {
            workspaceDir: params.workspace,
            beforePersistentEffect: params.beforePersistentEffect,
            onCapabilityConsent: activation?.prompter
              ? createPluginCapabilityConsentPrompter(activation.prompter, () =>
                  throwIfSetupInferenceCancelled(activation),
                )
              : undefined,
          },
        );
        if (!enabled.enabled) {
          return {
            error: `${params.choice.choiceLabel} is disabled (${enabled.reason ?? "blocked"}).`,
          };
        }
        const providers = (params.deps.resolvePluginProviders ?? resolvePluginProvidersCore)({
          config: enabled.config,
          workspaceDir: params.workspace,
          mode: "setup",
          cache: true,
          includeUntrustedWorkspacePlugins: false,
          onlyPluginIds: [params.choice.pluginId],
        });
        const provider = providers.find(
          (entry) =>
            entry.pluginId === params.choice.pluginId &&
            normalizeProviderId(entry.id) === normalizeProviderId(params.choice.providerId),
        );
        const method = provider?.auth.find((entry) => entry.id === params.choice.methodId);
        if (!provider || !method || !supportsSetupTextInference(method.wizard?.onboardingScopes)) {
          return { error: "That provider setup is not available on this Gateway." };
        }
        return { config: enabled.config, provider, method };
      }),
  );
  return "error" in loaded ? loaded : await withPluginCache(cache, () => consume(loaded));
}
