import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderPlugin } from "../plugins/types.js";

export const LOCAL_PROVIDER_ID = "local-provider";
export const LOCAL_PROVIDER_LABEL = "Local Provider";
export const LOCAL_AUTH_METHOD_ID = "local";
export const LOCAL_PROFILE_ID = `${LOCAL_PROVIDER_ID}:default`;
export const LOCAL_API_KEY = "local-provider-key";
export const LOCAL_DEFAULT_MODEL = `${LOCAL_PROVIDER_ID}/demo-model`;

export function buildProvider(): ProviderPlugin {
  return {
    id: LOCAL_PROVIDER_ID,
    label: LOCAL_PROVIDER_LABEL,
    auth: [
      {
        id: LOCAL_AUTH_METHOD_ID,
        label: LOCAL_PROVIDER_LABEL,
        kind: "custom",
        run: async () => ({
          profiles: [
            {
              profileId: LOCAL_PROFILE_ID,
              credential: {
                type: "api_key",
                provider: LOCAL_PROVIDER_ID,
                key: LOCAL_API_KEY,
              },
            },
          ],
          defaultModel: LOCAL_DEFAULT_MODEL,
        }),
      },
    ],
  };
}

export function buildProviderWithDefaultModelPatch(): ProviderPlugin {
  const provider = buildProvider();
  const method = expectDefined(provider.auth[0], "auth method");
  const run = method.run;
  method.run = async (ctx) => ({
    ...(await run(ctx)),
    configPatch: {
      agents: {
        defaults: {
          model: { primary: LOCAL_DEFAULT_MODEL },
          models: {
            [LOCAL_DEFAULT_MODEL]: { alias: "Local default" },
          },
        },
      },
    },
  });
  return provider;
}

export function buildLocalProviderInstallCatalogEntry() {
  return {
    pluginId: "local-provider-plugin",
    providerId: LOCAL_PROVIDER_ID,
    methodId: LOCAL_AUTH_METHOD_ID,
    choiceId: LOCAL_PROVIDER_ID,
    choiceLabel: LOCAL_PROVIDER_LABEL,
    label: LOCAL_PROVIDER_LABEL,
    origin: "bundled" as const,
    install: {
      npmSpec: "@openclaw/local-provider",
    },
  };
}

export function buildInstalledLocalProviderPluginResult() {
  return {
    cfg: {
      plugins: {
        entries: {
          "local-provider-plugin": {
            enabled: true,
          },
        },
      },
    },
    installed: true,
    pluginId: "local-provider-plugin",
    status: "installed" as const,
  };
}
