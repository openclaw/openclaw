import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
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

  // When gateway auth mode is "none", the gateway intentionally runs without
  // authentication — but the browser control surface must always be protected.
  // Generate a browser-specific token directly instead of delegating to
  // ensureGatewayStartupAuth (which would resolve mode="none" and skip token
  // generation).
  if (params.cfg.gateway?.auth?.mode === "none" || loadConfig().gateway?.auth?.mode === "none") {
    return generateBrowserToken(params.cfg);
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
  if (latestCfg.gateway?.auth?.mode === "trusted-proxy") {
    return { auth: latestAuth };
  }

  const ensured = await ensureGatewayStartupAuth({
    cfg: latestCfg,
    env,
    persist: true,
  });
  const ensuredAuth = {
    token: ensured.auth.token,
    password: ensured.auth.password,
  };
  return {
    auth: ensuredAuth,
    generatedToken: ensured.generatedToken,
  };
}

/**
 * Generate and persist a browser-specific auth token.  Used when the gateway
 * runs with auth.mode="none" so the browser control surface is still protected.
 */
async function generateBrowserToken(
  cfg: OpenClawConfig,
): Promise<{ auth: BrowserControlAuth; generatedToken: string }> {
  const generatedToken = crypto.randomBytes(24).toString("hex");
  const nextCfg: OpenClawConfig = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      auth: {
        ...cfg.gateway?.auth,
        mode: "token",
        token: generatedToken,
      },
    },
  };
  await writeConfigFile(nextCfg);
  return {
    auth: { token: generatedToken },
    generatedToken,
  };
}
