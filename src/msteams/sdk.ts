import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsCredentials } from "./token.js";

export type MSTeamsSdk = Awaited<
  ReturnType<typeof import("@microsoft/agents-hosting")>
>;

export async function loadMSTeamsSdk(): Promise<MSTeamsSdk> {
  return await import("@microsoft/agents-hosting");
}

export function buildMSTeamsAuthConfig(
  creds: MSTeamsCredentials,
  sdk: MSTeamsSdk,
) {
  return sdk.getAuthConfigWithDefaults({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  });
}

export function createMSTeamsAdapter(
  authConfig: unknown,
  sdk: MSTeamsSdk,
): MSTeamsAdapter {
  return new sdk.CloudAdapter(authConfig) as unknown as MSTeamsAdapter;
}

export async function loadMSTeamsSdkWithAuth(creds: MSTeamsCredentials) {
  const sdk = await loadMSTeamsSdk();
  const authConfig = buildMSTeamsAuthConfig(creds, sdk);
  return { sdk, authConfig };
}
