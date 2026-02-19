import crypto from "node:crypto";
import type {
  GatewayAuthConfig,
  GatewayTailscaleConfig,
  OpenClawConfig,
} from "../config/config.js";
import { writeConfigFile } from "../config/config.js";
import { resolveGatewayAuth, type ResolvedGatewayAuth } from "./auth.js";

export function mergeGatewayAuthConfig(
  base?: GatewayAuthConfig,
  override?: GatewayAuthConfig,
): GatewayAuthConfig {
  const merged: GatewayAuthConfig = { ...base };
  if (!override) {
    return merged;
  }
  if (override.mode !== undefined) {
    merged.mode = override.mode;
  }
  if (override.token !== undefined) {
    merged.token = override.token;
  }
  if (override.password !== undefined) {
    merged.password = override.password;
  }
  if (override.allowTailscale !== undefined) {
    merged.allowTailscale = override.allowTailscale;
  }
  if (override.rateLimit !== undefined) {
    merged.rateLimit = override.rateLimit;
  }
  if (override.trustedProxy !== undefined) {
    merged.trustedProxy = override.trustedProxy;
  }
  return merged;
}

export function mergeGatewayTailscaleConfig(
  base?: GatewayTailscaleConfig,
  override?: GatewayTailscaleConfig,
): GatewayTailscaleConfig {
  const merged: GatewayTailscaleConfig = { ...base };
  if (!override) {
    return merged;
  }
  if (override.mode !== undefined) {
    merged.mode = override.mode;
  }
  if (override.resetOnExit !== undefined) {
    merged.resetOnExit = override.resetOnExit;
  }
  return merged;
}

function resolveGatewayAuthFromConfig(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
}) {
  const tailscaleConfig = mergeGatewayTailscaleConfig(
    params.cfg.gateway?.tailscale,
    params.tailscaleOverride,
  );
  return resolveGatewayAuth({
    authConfig: params.cfg.gateway?.auth,
    authOverride: params.authOverride,
    env: params.env,
    tailscaleMode: tailscaleConfig.mode ?? "off",
  });
}

function shouldPersistGeneratedToken(params: {
  persistRequested: boolean;
  resolvedAuth: ResolvedGatewayAuth;
}): boolean {
  if (!params.persistRequested) {
    return false;
  }

  // Keep CLI/runtime mode overrides ephemeral: startup should not silently
  // mutate durable auth policy when mode was chosen by an override flag.
  if (params.resolvedAuth.modeSource === "override") {
    return false;
  }

  return true;
}

export async function ensureGatewayStartupAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  persist?: boolean;
}): Promise<{
  cfg: OpenClawConfig;
  auth: ReturnType<typeof resolveGatewayAuth>;
  generatedToken?: string;
  persistedGeneratedToken: boolean;
}> {
  const env = params.env ?? process.env;
  const persistRequested = params.persist === true;
  const resolved = resolveGatewayAuthFromConfig({
    cfg: params.cfg,
    env,
    authOverride: params.authOverride,
    tailscaleOverride: params.tailscaleOverride,
  });
  if (resolved.mode !== "token" || (resolved.token?.trim().length ?? 0) > 0) {
    return { cfg: params.cfg, auth: resolved, persistedGeneratedToken: false };
  }

  const generatedToken = crypto.randomBytes(24).toString("hex");
  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        mode: "token",
        token: generatedToken,
      },
    },
  };
  const persist = shouldPersistGeneratedToken({
    persistRequested,
    resolvedAuth: resolved,
  });
  if (persist) {
    await writeConfigFile(nextCfg);
  }

  const nextAuth = resolveGatewayAuthFromConfig({
    cfg: nextCfg,
    env,
    authOverride: params.authOverride,
    tailscaleOverride: params.tailscaleOverride,
  });
  return {
    cfg: nextCfg,
    auth: nextAuth,
    generatedToken,
    persistedGeneratedToken: persist,
  };
}
