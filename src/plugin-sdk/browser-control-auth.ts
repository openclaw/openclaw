import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

export function resolveBrowserControlAuth(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  const auth = resolveGatewayAuth({
    authConfig: cfg?.gateway?.auth,
    env,
    tailscaleMode: cfg?.gateway?.tailscale?.mode,
  });
  const token = normalizeOptionalString(auth.token) ?? "";
  const password = normalizeOptionalString(auth.password) ?? "";
  return {
    token: token || undefined,
    password: password || undefined,
  };
}

export function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = normalizeLowercaseStringOrEmpty(env.NODE_ENV);
  if (nodeEnv === "test") {
    return false;
  }
  const vitest = normalizeLowercaseStringOrEmpty(env.VITEST);
  if (vitest && vitest !== "0" && vitest !== "false" && vitest !== "off") {
    return false;
  }
  return true;
}

function hasExplicitNonStringGatewayCredentialForMode(params: {
  cfg?: OpenClawConfig;
  mode: "none" | "trusted-proxy";
}): boolean {
  const { cfg, mode } = params;
  const auth = cfg?.gateway?.auth;
  if (!auth) {
    return false;
  }
  if (mode === "none") {
    return auth.token != null && typeof auth.token !== "string";
  }
  return auth.password != null && typeof auth.password !== "string";
}

function generateBrowserControlToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

async function generateAndPersistBrowserControlToken(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const token = generateBrowserControlToken();
  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        token,
      },
    },
  };
  await writeConfigFile(nextCfg);

  const persistedAuth = resolveBrowserControlAuth(loadConfig(), params.env);
  if (persistedAuth.token || persistedAuth.password) {
    return {
      auth: persistedAuth,
      generatedToken: persistedAuth.token === token ? token : undefined,
    };
  }

  return { auth: { token }, generatedToken: token };
}

async function generateAndPersistBrowserControlPassword(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const password = generateBrowserControlToken();
  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        password,
      },
    },
  };
  await writeConfigFile(nextCfg);

  const persistedAuth = resolveBrowserControlAuth(loadConfig(), params.env);
  if (persistedAuth.token || persistedAuth.password) {
    return {
      auth: persistedAuth,
      generatedToken: persistedAuth.password === password ? password : undefined,
    };
  }

  return { auth: { password }, generatedToken: password };
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

  if (params.cfg.gateway?.auth?.mode === "password") {
    return { auth };
  }

  const latestCfg = loadConfig();
  const latestAuth = resolveBrowserControlAuth(latestCfg, env);
  if (latestAuth.token || latestAuth.password) {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "password") {
    return { auth: latestAuth };
  }
  const latestMode = latestCfg.gateway?.auth?.mode;
  if (latestMode === "none" || latestMode === "trusted-proxy") {
    if (
      hasExplicitNonStringGatewayCredentialForMode({
        cfg: latestCfg,
        mode: latestMode,
      })
    ) {
      return { auth: latestAuth };
    }
    if (latestMode === "trusted-proxy") {
      return await generateAndPersistBrowserControlPassword({ cfg: latestCfg, env });
    }
    return await generateAndPersistBrowserControlToken({ cfg: latestCfg, env });
  }

  const ensured = await ensureGatewayStartupAuth({
    cfg: latestCfg,
    env,
    persist: true,
  });
  return {
    auth: {
      token: ensured.auth.token,
      password: ensured.auth.password,
    },
    generatedToken: ensured.generatedToken,
  };
}
