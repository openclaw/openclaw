import type { MSTeamsConfig } from "../config/types.js";
import { formatUnknownError } from "./errors.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";

export type ProbeMSTeamsResult = {
  ok: boolean;
  error?: string;
  appId?: string;
};

export async function probeMSTeams(
  cfg?: MSTeamsConfig,
): Promise<ProbeMSTeamsResult> {
  const creds = resolveMSTeamsCredentials(cfg);
  if (!creds) {
    return {
      ok: false,
      error: "missing credentials (appId, appPassword, tenantId)",
    };
  }

  try {
    const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
    const tokenProvider = new sdk.MsalTokenProvider(authConfig);
    await tokenProvider.getAccessToken("https://api.botframework.com/.default");
    return { ok: true, appId: creds.appId };
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: formatUnknownError(err),
    };
  }
}
