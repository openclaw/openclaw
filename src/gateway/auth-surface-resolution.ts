import type { OpenClawConfig } from "../config/types.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { trimToUndefined, type ExplicitGatewayAuth } from "./credentials.js";
import { resolveConfiguredSecretInputString } from "./resolve-configured-secret-input-string.js";

type GatewayCredentialPath =
  | "gateway.auth.token"
  | "gateway.auth.password"
  | "gateway.remote.token"
  | "gateway.remote.password";

type ResolvedGatewayCredential = {
  value?: string;
  unresolvedRefReason?: string;
};

async function resolveGatewayCredential(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  diagnostics: string[];
  path: GatewayCredentialPath;
  value: unknown;
}): Promise<ResolvedGatewayCredential> {
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: params.env,
    value: params.value,
    path: params.path,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.unresolvedRefReason) {
    params.diagnostics.push(resolved.unresolvedRefReason);
  }
  return resolved;
}

function withDiagnostics<T extends object>(params: {
  diagnostics: string[];
  result: T;
}): T & { diagnostics?: string[] } {
  return params.diagnostics.length > 0
    ? { ...params.result, diagnostics: params.diagnostics }
    : params.result;
}

/** Resolve best-effort credentials for non-interactive Gateway status/probe calls. */
export async function resolveGatewayProbeSurfaceAuth(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  surface: "local" | "remote";
}): Promise<{ token?: string; password?: string; diagnostics?: string[] }> {
  const env = params.env ?? process.env;
  const diagnostics: string[] = [];
  const authMode = params.config.gateway?.auth?.mode;

  if (params.surface === "remote") {
    // Remote probes avoid password lookup when a token exists because remote
    // gateway status uses one auth method and should not surface unused refs.
    const remoteToken = await resolveGatewayCredential({
      config: params.config,
      env,
      diagnostics,
      path: "gateway.remote.token",
      value: params.config.gateway?.remote?.token,
    });
    const remotePassword = remoteToken.value
      ? { value: undefined }
      : await resolveGatewayCredential({
          config: params.config,
          env,
          diagnostics,
          path: "gateway.remote.password",
          value: params.config.gateway?.remote?.password,
        });
    return withDiagnostics({
      diagnostics,
      result: { token: remoteToken.value, password: remotePassword.value },
    });
  }

  if (authMode === "none" || authMode === "trusted-proxy") {
    return {};
  }

  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  if (authMode === "token") {
    const token = await resolveGatewayCredential({
      config: params.config,
      env,
      diagnostics,
      path: "gateway.auth.token",
      value: params.config.gateway?.auth?.token,
    });
    return token.value
      ? withDiagnostics({ diagnostics, result: { token: token.value } })
      : envToken
        ? { token: envToken }
        : withDiagnostics({ diagnostics, result: {} });
  }

  if (authMode === "password") {
    const password = await resolveGatewayCredential({
      config: params.config,
      env,
      diagnostics,
      path: "gateway.auth.password",
      value: params.config.gateway?.auth?.password,
    });
    return password.value
      ? withDiagnostics({ diagnostics, result: { password: password.value } })
      : envPassword
        ? { password: envPassword }
        : withDiagnostics({ diagnostics, result: {} });
  }

  const token = await resolveGatewayCredential({
    config: params.config,
    env,
    diagnostics,
    path: "gateway.auth.token",
    value: params.config.gateway?.auth?.token,
  });
  if (token.value) {
    return withDiagnostics({ diagnostics, result: { token: token.value } });
  }
  if (envToken) {
    return { token: envToken };
  }
  if (envPassword) {
    return withDiagnostics({ diagnostics, result: { password: envPassword } });
  }
  const password = await resolveGatewayCredential({
    config: params.config,
    env,
    diagnostics,
    path: "gateway.auth.password",
    value: params.config.gateway?.auth?.password,
  });
  return withDiagnostics({
    diagnostics,
    result: { token: token.value, password: password.value },
  });
}

/** Resolve Gateway credentials for interactive clients, returning a user-facing failure reason. */
export async function resolveGatewayInteractiveSurfaceAuth(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  suppressEnvAuthFallback?: boolean;
  surface: "local" | "remote";
}): Promise<{
  token?: string;
  password?: string;
  failureReason?: string;
}> {
  const env = params.env ?? process.env;
  const diagnostics: string[] = [];
  const explicitToken = trimToUndefined(params.explicitAuth?.token);
  const explicitPassword = trimToUndefined(params.explicitAuth?.password);
  const envToken = params.suppressEnvAuthFallback
    ? undefined
    : trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = params.suppressEnvAuthFallback
    ? undefined
    : trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  if (params.surface === "remote") {
    // Interactive remote clients accept explicit/env credentials as fallbacks
    // even when configured secret refs are missing, so users can recover from
    // broken remote config without editing files first.
    const remoteToken = explicitToken
      ? { value: explicitToken }
      : await resolveGatewayCredential({
          config: params.config,
          env,
          diagnostics,
          path: "gateway.remote.token",
          value: params.config.gateway?.remote?.token,
        });
    const remotePassword =
      explicitPassword || envPassword
        ? { value: explicitPassword ?? envPassword }
        : await resolveGatewayCredential({
            config: params.config,
            env,
            diagnostics,
            path: "gateway.remote.password",
            value: params.config.gateway?.remote?.password,
          });
    const token = explicitToken ?? remoteToken.value ?? envToken;
    const password = explicitPassword ?? envPassword ?? remotePassword.value;
    return token || password
      ? { token, password }
      : {
          failureReason:
            remoteToken.unresolvedRefReason ??
            remotePassword.unresolvedRefReason ??
            "Missing gateway auth credentials.",
        };
  }

  const authMode = params.config.gateway?.auth?.mode;
  if (authMode === "none" || authMode === "trusted-proxy") {
    return {
      token: explicitToken ?? envToken,
      password: explicitPassword ?? envPassword,
    };
  }

  const hasConfiguredToken = hasConfiguredSecretInput(
    params.config.gateway?.auth?.token,
    params.config.secrets?.defaults,
  );
  const hasConfiguredPassword = hasConfiguredSecretInput(
    params.config.gateway?.auth?.password,
    params.config.secrets?.defaults,
  );

  const resolveToken = async () => {
    const localToken = explicitToken
      ? { value: explicitToken }
      : await resolveGatewayCredential({
          config: params.config,
          env,
          diagnostics,
          path: "gateway.auth.token",
          value: params.config.gateway?.auth?.token,
        });
    const token = explicitToken ?? localToken.value ?? envToken;
    return {
      token,
      failureReason: token
        ? undefined
        : (localToken.unresolvedRefReason ?? "Missing gateway auth token."),
    };
  };

  const resolvePassword = async () => {
    const localPassword =
      explicitPassword || envPassword
        ? { value: explicitPassword ?? envPassword }
        : await resolveGatewayCredential({
            config: params.config,
            env,
            diagnostics,
            path: "gateway.auth.password",
            value: params.config.gateway?.auth?.password,
          });
    const password = explicitPassword ?? envPassword ?? localPassword.value;
    return {
      password,
      failureReason: password
        ? undefined
        : (localPassword.unresolvedRefReason ?? "Missing gateway auth password."),
    };
  };

  if (authMode === "password") {
    const password = await resolvePassword();
    return {
      token: explicitToken ?? envToken,
      password: password.password,
      failureReason: password.failureReason,
    };
  }

  if (authMode === "token") {
    const token = await resolveToken();
    return {
      token: token.token,
      password: explicitPassword ?? envPassword,
      failureReason: token.failureReason,
    };
  }

  const shouldUsePassword =
    Boolean(explicitPassword ?? envPassword) || (hasConfiguredPassword && !hasConfiguredToken);
  // Without an explicit mode, password wins only when it is the only configured
  // auth secret or the caller supplied one directly; otherwise token remains the
  // local default to match startup/probe behavior.
  if (shouldUsePassword) {
    const password = await resolvePassword();
    return {
      token: explicitToken ?? envToken,
      password: password.password,
      failureReason: password.failureReason,
    };
  }

  const token = await resolveToken();
  return {
    token: token.token,
    password: explicitPassword ?? envPassword,
    failureReason: token.failureReason,
  };
}
