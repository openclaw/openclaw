import type { MSTeamsConfig } from "../config/types.js";
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

  // TODO: Validate credentials by attempting to get a token
  return { ok: true, appId: creds.appId };
}
