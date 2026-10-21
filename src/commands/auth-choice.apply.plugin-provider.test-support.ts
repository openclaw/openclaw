import { createApiKeyCredential } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import type { ProviderPlugin, ProviderAuthResult } from "../plugins/types.js";

export const LOCAL_PROVIDER_ID = "local-provider";
export const LOCAL_PROVIDER_LABEL = "Local Provider";
const LOCAL_AUTH_METHOD_ID = "local";
export const LOCAL_PROFILE_ID = `${LOCAL_PROVIDER_ID}:default`;
export const LOCAL_API_KEY = "local-provider-key";
export const LOCAL_DEFAULT_MODEL = `${LOCAL_PROVIDER_ID}/demo-model`;

export function buildProvider({
  id = LOCAL_PROVIDER_ID,
  aliases,
  key = LOCAL_API_KEY,
  method,
  result,
}: {
  id?: string;
  aliases?: string[];
  key?: string;
  method?: Partial<ProviderPlugin["auth"][number]>;
  result?: Partial<ProviderAuthResult>;
} = {}): ProviderPlugin {
  return {
    id,
    label: id === LOCAL_PROVIDER_ID ? LOCAL_PROVIDER_LABEL : id,
    aliases,
    auth: [
      {
        id: LOCAL_AUTH_METHOD_ID,
        label: LOCAL_PROVIDER_LABEL,
        kind: "custom",
        run: async () => ({
          profiles: [
            {
              profileId: `${id}:default`,
              credential: createApiKeyCredential(id, key),
            },
          ],
          defaultModel: LOCAL_DEFAULT_MODEL,
          ...result,
        }),
        ...method,
      },
    ],
  };
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
