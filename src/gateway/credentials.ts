import type { OpenClawConfig } from "../config/config.js";

export type ExplicitGatewayAuth = {
  token?: string;
  password?: string;
};

export type ResolvedGatewayCredentials = {
  token?: string;
  password?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveGatewayCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  remotePasswordPrecedence?: "remote-first" | "env-first";
}): ResolvedGatewayCredentials {
  const env = params.env ?? process.env;
  const explicitToken = trimToUndefined(params.explicitAuth?.token);
  const explicitPassword = trimToUndefined(params.explicitAuth?.password);
  if (explicitToken || explicitPassword) {
    return { token: explicitToken, password: explicitPassword };
  }
  if (trimToUndefined(params.urlOverride)) {
    return {};
  }

  const isRemoteMode = params.cfg.gateway?.mode === "remote";
  const remote = isRemoteMode ? params.cfg.gateway?.remote : undefined;

  const envToken =
    trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN) ?? trimToUndefined(env.CLAWDBOT_GATEWAY_TOKEN);
  const envPassword =
    trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD) ??
    trimToUndefined(env.CLAWDBOT_GATEWAY_PASSWORD);

  const remoteToken = trimToUndefined(remote?.token);
  const remotePassword = trimToUndefined(remote?.password);
  const localToken = trimToUndefined(params.cfg.gateway?.auth?.token);
  const localPassword = trimToUndefined(params.cfg.gateway?.auth?.password);

  const token = isRemoteMode ? (remoteToken ?? envToken ?? localToken) : (envToken ?? localToken);
  const passwordPrecedence = params.remotePasswordPrecedence ?? "remote-first";
  const password = isRemoteMode
    ? passwordPrecedence === "env-first"
      ? (envPassword ?? remotePassword ?? localPassword)
      : (remotePassword ?? envPassword ?? localPassword)
    : (envPassword ?? localPassword);

  return { token, password };
}
