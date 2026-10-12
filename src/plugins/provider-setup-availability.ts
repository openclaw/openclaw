import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { enablePluginInConfig, enablePluginWithCapabilityConsent } from "./enable.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoices,
} from "./provider-auth-choices.js";
import type { ProviderAppGuidedSetupContext } from "./provider-authentication.types.js";
import { resolvePluginProvidersCore } from "./providers.runtime.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins/provider-setup-availability");

/** Import accepted choices under a short lease; retain their callbacks through every probe. */
export async function probeSetupProviderChoices<T>(
  params: {
    config: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    choices: readonly ProviderAuthChoiceMetadata[];
    enablePluginInConfig?: typeof enablePluginInConfig;
    resolvePluginProviders?: typeof resolvePluginProvidersCore;
  },
  probe: (
    choice: ProviderAuthChoiceMetadata,
    provider: ProviderPlugin | undefined,
    context: ProviderAppGuidedSetupContext,
  ) => Promise<T>,
): Promise<T[]> {
  await using cache = createPluginCache();
  const env = params.env ?? process.env;
  const discovery = await withPluginLifecycleLease({ env, signal: params.signal }, async () =>
    withPluginCache(cache, async () => {
      let config = params.config;
      const choices: ProviderAuthChoiceMetadata[] = [];
      for (const choice of params.choices) {
        params.signal?.throwIfAborted();
        const enabled = await enablePluginWithCapabilityConsent(params.config, choice.pluginId, {
          env,
          workspaceDir: params.workspaceDir,
        });
        params.signal?.throwIfAborted();
        if (enabled.enabled) {
          config = (params.enablePluginInConfig ?? enablePluginInConfig)(
            config,
            choice.pluginId,
          ).config;
          choices.push(choice);
        }
      }
      const providers = choices.length
        ? (params.resolvePluginProviders ?? resolvePluginProvidersCore)({
            config,
            workspaceDir: params.workspaceDir,
            env,
            mode: "setup",
            // Cached registries bind their instances to this operation's retirement.
            cache: true,
            includeUntrustedWorkspacePlugins: false,
            onlyPluginIds: uniqueStrings(choices.map((choice) => choice.pluginId)),
          })
        : [];
      return { config, choices, providers };
    }),
  );
  params.signal?.throwIfAborted();
  return await withPluginCache(cache, () =>
    Promise.all(
      discovery.choices.map((choice) =>
        probe(
          choice,
          discovery.providers.find(
            (provider) =>
              provider.pluginId === choice.pluginId &&
              normalizeProviderId(provider.id) === normalizeProviderId(choice.providerId),
          ),
          {
            config: discovery.config,
            env,
            workspaceDir: params.workspaceDir,
            signal: params.signal,
          },
        ),
      ),
    ),
  );
}

/** Detect reachable provider-owned services for the classic setup picker. */
export async function detectAvailableSetupProviderIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReadonlySet<string>> {
  const choices = resolveManifestProviderAuthChoices({
    ...params,
    env: params.env ?? process.env,
    includeUntrustedWorkspacePlugins: false,
  }).filter(
    (choice) =>
      choice.appGuidedDiscovery === true &&
      choice.assistantVisibility !== "manual-only" &&
      (!choice.onboardingScopes || choice.onboardingScopes.includes("text-inference")),
  );
  const detected = await probeSetupProviderChoices(
    { ...params, choices },
    async (choice, provider, context) => {
      const method = provider?.auth.find(
        (candidate) => normalizeProviderId(candidate.id) === normalizeProviderId(choice.methodId),
      );
      if (!method?.appGuidedSetup?.detectAvailability) {
        return undefined;
      }
      try {
        return (await method.appGuidedSetup.detectAvailability(context))
          ? choice.providerId
          : undefined;
      } catch (error) {
        log.debug(
          `Provider availability detection failed for ${choice.choiceId}: ${formatErrorMessage(error)}`,
        );
        return undefined;
      }
    },
  );
  return new Set(detected.filter((providerId): providerId is string => Boolean(providerId)));
}
