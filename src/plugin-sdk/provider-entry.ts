import type { ProviderPlugin, ProviderPluginWizardSetup } from "../plugins/types.js";
import { definePluginEntry } from "./plugin-entry.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
} from "./plugin-entry.js";
import { createProviderApiKeyAuthMethod } from "./provider-auth.js";
import { buildSingleProviderApiKeyCatalog } from "./provider-catalog.js";

type ApiKeyAuthMethodOptions = Parameters<typeof createProviderApiKeyAuthMethod>[0];

export type SingleProviderPluginApiKeyAuthOptions = Omit<
  ApiKeyAuthMethodOptions,
  "providerId" | "expectedProviders" | "wizard"
> & {
  expectedProviders?: string[];
  wizard?: false | ProviderPluginWizardSetup;
};

export type SingleProviderPluginCatalogOptions = {
  buildProvider: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
  allowExplicitBaseUrl?: boolean;
};

export type SingleProviderPluginOptions = {
  id: string;
  name: string;
  description: string;
  kind?: OpenClawPluginDefinition["kind"];
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  provider?: {
    id?: string;
    label: string;
    docsPath: string;
    aliases?: string[];
    envVars?: string[];
    auth?: SingleProviderPluginApiKeyAuthOptions[];
    catalog: SingleProviderPluginCatalogOptions;
  } & Omit<
    ProviderPlugin,
    "id" | "label" | "docsPath" | "aliases" | "envVars" | "auth" | "catalog"
  >;
  register?: (api: OpenClawPluginApi) => void;
};

function resolveWizardSetup(params: {
  providerId: string;
  providerLabel: string;
  auth: SingleProviderPluginApiKeyAuthOptions;
}): ProviderPluginWizardSetup | undefined {
  if (params.auth.wizard === false) {
    return undefined;
  }
  const wizard = params.auth.wizard ?? {};
  const methodId = params.auth.methodId.trim();
  return {
    choiceId: wizard.choiceId ?? `${params.providerId}-${methodId}`,
    choiceLabel: wizard.choiceLabel ?? params.auth.label,
    ...(wizard.choiceHint ? { choiceHint: wizard.choiceHint } : {}),
    groupId: wizard.groupId ?? params.providerId,
    groupLabel: wizard.groupLabel ?? params.providerLabel,
    ...((wizard.groupHint ?? params.auth.hint)
      ? { groupHint: wizard.groupHint ?? params.auth.hint }
      : {}),
    methodId,
    ...(wizard.onboardingScopes ? { onboardingScopes: wizard.onboardingScopes } : {}),
    ...(wizard.modelAllowlist ? { modelAllowlist: wizard.modelAllowlist } : {}),
  };
}

function resolveEnvVars(params: {
  envVars?: string[];
  auth?: SingleProviderPluginApiKeyAuthOptions[];
}): string[] | undefined {
  const combined = [
    ...(params.envVars ?? []),
    ...(params.auth ?? []).map((entry) => entry.envVar).filter(Boolean),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return combined.length > 0 ? [...new Set(combined)] : undefined;
}

export function defineSingleProviderPluginEntry(options: SingleProviderPluginOptions) {
  return definePluginEntry({
    id: options.id,
    name: options.name,
    description: options.description,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.configSchema ? { configSchema: options.configSchema } : {}),
    register(api) {
      const provider = options.provider;
      if (provider) {
        const providerId = provider.id ?? options.id;
        const envVars = resolveEnvVars({
          envVars: provider.envVars,
          auth: provider.auth,
        });
        const auth = (provider.auth ?? []).map((entry) => {
          const { wizard: _wizard, ...authParams } = entry;
          const wizard = resolveWizardSetup({
            providerId,
            providerLabel: provider.label,
            auth: entry,
          });
          return createProviderApiKeyAuthMethod({
            ...authParams,
            providerId,
            expectedProviders: entry.expectedProviders ?? [providerId],
            ...(wizard ? { wizard } : {}),
          });
        });
        api.registerProvider({
          id: providerId,
          label: provider.label,
          docsPath: provider.docsPath,
          ...(provider.aliases ? { aliases: provider.aliases } : {}),
          ...(envVars ? { envVars } : {}),
          auth,
          catalog: {
            order: "simple",
            run: (ctx) =>
              buildSingleProviderApiKeyCatalog({
                ctx,
                providerId,
                buildProvider: provider.catalog.buildProvider,
                ...(provider.catalog.allowExplicitBaseUrl ? { allowExplicitBaseUrl: true } : {}),
              }),
          },
          ...Object.fromEntries(
            Object.entries(provider).filter(
              ([key]) =>
                !["id", "label", "docsPath", "aliases", "envVars", "auth", "catalog"].includes(key),
            ),
          ),
        });
      }
      options.register?.(api);
    },
  });
}
