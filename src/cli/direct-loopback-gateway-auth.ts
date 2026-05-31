import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { isLoopbackHost } from "../gateway/net.js";

export type DirectLoopbackGatewayAuthOpts = {
  url?: string;
  token?: string;
  password?: string;
  config?: OpenClawConfig;
};

type SharedGatewayCredentials = {
  token?: string;
  password?: string;
};

function pickActiveGatewayCredential(
  mode: "token" | "password",
  credentials: SharedGatewayCredentials | undefined,
): SharedGatewayCredentials | undefined {
  if (!credentials) {
    return undefined;
  }
  const credential =
    mode === "token" ? { token: credentials.token } : { password: credentials.password };
  return credential.token || credential.password ? credential : undefined;
}

function hasActiveGatewayAuthSecretRef(
  config: OpenClawConfig | undefined,
  mode: "token" | "password",
): boolean {
  if (!config) {
    return false;
  }
  const value = mode === "token" ? config.gateway?.auth?.token : config.gateway?.auth?.password;
  return Boolean(resolveSecretInputRef({ value, defaults: config.secrets?.defaults }).ref);
}

async function resolveConfiguredSharedGatewayCredentials(
  config: OpenClawConfig | undefined,
): Promise<SharedGatewayCredentials | undefined> {
  const resolvedConfig = config ?? loadConfigForDirectAuthProbe();
  if (!resolvedConfig) {
    return undefined;
  }
  const auth = resolveGatewayAuth({
    authConfig: resolvedConfig?.gateway?.auth,
    tailscaleMode: resolvedConfig?.gateway?.tailscale?.mode,
    env: process.env,
  });
  if (auth.mode !== "token" && auth.mode !== "password") {
    return undefined;
  }
  if (hasActiveGatewayAuthSecretRef(resolvedConfig, auth.mode)) {
    try {
      const credentials = await resolveGatewayConnectionAuth({
        config: resolvedConfig,
        env: process.env,
        localTokenPrecedence: "config-first",
        localPasswordPrecedence: "config-first",
      });
      return pickActiveGatewayCredential(auth.mode, credentials);
    } catch {
      return undefined;
    }
  }
  const literalCredentials = pickActiveGatewayCredential(auth.mode, {
    token: auth.token,
    password: auth.password,
  });
  if (literalCredentials?.token || literalCredentials?.password) {
    return literalCredentials;
  }
  try {
    const credentials = await resolveGatewayConnectionAuth({
      config: resolvedConfig,
      env: process.env,
    });
    return pickActiveGatewayCredential(auth.mode, credentials);
  } catch {
    return undefined;
  }
}

async function isConfiguredSharedGatewayToken(params: {
  token: string | undefined;
  config?: OpenClawConfig;
}): Promise<boolean> {
  if (!params.token) {
    return false;
  }
  const credentials = await resolveConfiguredSharedGatewayCredentials(params.config);
  return credentials?.token === params.token;
}

async function isConfiguredSharedGatewayPassword(params: {
  password: string | undefined;
  config?: OpenClawConfig;
}): Promise<boolean> {
  if (!params.password) {
    return false;
  }
  const credentials = await resolveConfiguredSharedGatewayCredentials(params.config);
  return credentials?.password === params.password;
}

function loadConfigForDirectAuthProbe(): OpenClawConfig | undefined {
  try {
    return loadConfig({ skipPluginValidation: true, pin: false });
  } catch {
    return undefined;
  }
}

function isLoopbackGatewayUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function resolveGatewayUrlForDirectAuth(opts: DirectLoopbackGatewayAuthOpts): string | undefined {
  const explicitUrl = normalizeStringifiedOptionalString(opts.url);
  if (explicitUrl) {
    return explicitUrl;
  }
  try {
    return buildGatewayConnectionDetails({ config: opts.config }).url;
  } catch {
    return undefined;
  }
}

export async function shouldUseDirectLoopbackGatewayAuth(
  opts: DirectLoopbackGatewayAuthOpts,
): Promise<boolean> {
  const token = normalizeStringifiedOptionalString(opts.token);
  const password = normalizeStringifiedOptionalString(opts.password);
  const explicitUrl = normalizeStringifiedOptionalString(opts.url);
  if (explicitUrl && !isLoopbackGatewayUrl(explicitUrl)) {
    return false;
  }
  const configuredCredentials =
    !token && !password ? await resolveConfiguredSharedGatewayCredentials(opts.config) : undefined;
  if (!token && !password && !configuredCredentials?.token && !configuredCredentials?.password) {
    return false;
  }
  const gatewayUrl = resolveGatewayUrlForDirectAuth(opts);
  if (!isLoopbackGatewayUrl(gatewayUrl)) {
    return false;
  }
  if (!token && !password) {
    return true;
  }
  return (
    (await isConfiguredSharedGatewayPassword({ password, config: opts.config })) ||
    (await isConfiguredSharedGatewayToken({ token, config: opts.config }))
  );
}
