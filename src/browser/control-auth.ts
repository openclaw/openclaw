import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

export function resolveBrowserControlAuth(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  const auth = resolveGatewayAuth({
    authConfig: cfg?.gateway?.auth,
    env,
    tailscaleMode: cfg?.gateway?.tailscale?.mode,
  });
  const token = typeof auth.token === "string" ? auth.token.trim() : "";
  const password = typeof auth.password === "string" ? auth.password.trim() : "";
  return {
    token: token || undefined,
    password: password || undefined,
  };
}

function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "test") {
    return false;
  }
  const vitest = (env.VITEST ?? "").trim().toLowerCase();
  if (vitest && vitest !== "0" && vitest !== "false" && vitest !== "off") {
    return false;
  }
  return true;
}

export async function ensureBrowserControlAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const env = params.env ?? process.env;
  const auth = resolveBrowserControlAuth(params.cfg, env);
  if (auth.token || auth.password) {
    return { auth };
  }
  if (!shouldAutoGenerateBrowserAuth(env)) {
    return { auth };
  }

  // Respect explicit password mode even if currently unset.
  if (params.cfg.gateway?.auth?.mode === "password") {
    return { auth };
  }

  if (params.cfg.gateway?.auth?.mode === "none") {
    return { auth };
  }

  if (params.cfg.gateway?.auth?.mode === "trusted-proxy") {
    return { auth };
  }

  // Re-read latest config to avoid racing with concurrent config writers.
  const latestCfg = loadConfig();
  const latestAuth = resolveBrowserControlAuth(latestCfg, env);
  if (latestAuth.token || latestAuth.password) {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "password") {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "none") {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "trusted-proxy") {
    return { auth: latestAuth };
  }

  const ensured = await ensureGatewayStartupAuth({
    cfg: latestCfg,
    env,
    persist: true,
  });
  const ensuredAuth = resolveBrowserControlAuth(ensured.cfg, env);
  return {
    auth: ensuredAuth,
    generatedToken: ensured.generatedToken,
  };
}
