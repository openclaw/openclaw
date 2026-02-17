import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderAuthResult } from "../plugins/types.js";

export function buildOauthProviderAuthResult(params: {
  providerId: string;
  defaultModel: string;
  access: string;
  refresh?: string | null;
  expires?: number | null;
  email?: string | null;
  profilePrefix?: string;
  credentialExtra?: Record<string, unknown>;
  configPatch?: Partial<OpenClawConfig>;
  notes?: string[];
}): ProviderAuthResult {
  const email = params.email ?? undefined;
  const profilePrefix = params.profilePrefix ?? params.providerId;
  const profileId = `${profilePrefix}:${email ?? "default"}`;

  const credential: AuthProfileCredential = {
    type: "oauth",
    provider: params.providerId,
    access: params.access,
    ...(params.refresh ? { refresh: params.refresh } : {}),
    ...(Number.isFinite(params.expires) ? { expires: params.expires as number } : {}),
    ...(email ? { email } : {}),
    ...params.credentialExtra,
  } as AuthProfileCredential;

  return {
    profiles: [{ profileId, credential }],
    configPatch:
      params.configPatch ??
      ({
        agents: {
          defaults: {
            models: {
              [params.defaultModel]: {},
            },
          },
        },
      } as Partial<OpenClawConfig>),
    defaultModel: params.defaultModel,
    notes: params.notes,
  };
}
