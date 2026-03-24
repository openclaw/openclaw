import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { coerceSecretRef } from "../config/types.secrets.js";
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

  // trusted-proxy mode: the gateway authenticates via proxy headers, not
  // tokens, so ensureGatewayStartupAuth will not generate a credential.
  // Generate a browser-specific loopback token directly so the browser
  // control server always starts with auth middleware installed.
  // Skip generation if gateway.auth.token is a SecretRef (object) — the
  // operator intentionally manages it externally and resolution may have
  // failed temporarily; overwriting would cause config drift.
  if (latestCfg.gateway?.auth?.mode === "trusted-proxy") {
    const existingTokenValue = latestCfg.gateway?.auth?.token;
    if (coerceSecretRef(existingTokenValue, latestCfg.secrets?.defaults)) {
      return { auth };
    }
    const generatedToken = crypto.randomBytes(24).toString("hex");
    const nextCfg: OpenClawConfig = {
      ...latestCfg,
      gateway: {
        ...latestCfg.gateway,
        auth: {
          ...latestCfg.gateway?.auth,
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
