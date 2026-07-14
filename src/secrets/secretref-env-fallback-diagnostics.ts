/** Detects configured SecretRefs that resolve via provider env fallback at runtime. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayAuth } from "../gateway/auth-resolve.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";
import type { SecretResolverWarningCode } from "./runtime-shared.js";

type SecretRefEnvFallbackDiagnostic = {
  code: string;
  path: string;
  message: string;
};

const RUNTIME_FALLBACK_WARNING_CODES = new Set<SecretResolverWarningCode>([
  "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED",
  "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED",
]);

function dedupeDiagnostics(
  diagnostics: SecretRefEnvFallbackDiagnostic[],
): SecretRefEnvFallbackDiagnostic[] {
  const seen = new Set<string>();
  const out: SecretRefEnvFallbackDiagnostic[] = [];
  for (const entry of diagnostics) {
    const key = `${entry.code}:${entry.path}:${entry.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function isActiveGatewayTokenSurface(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean {
  const auth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
    env,
  });
  const tokenRef = resolveSecretInputRef({
    value: cfg.gateway?.auth?.token,
    defaults: cfg.secrets?.defaults,
  }).ref;
  const hasInlineToken = typeof auth.token === "string" && auth.token.trim() !== "";
  return (
    auth.mode !== "password" &&
    auth.mode !== "none" &&
    auth.mode !== "trusted-proxy" &&
    (auth.mode !== "token" || !hasInlineToken || Boolean(tokenRef))
  );
}

async function collectGatewayAuthTokenEnvFallbackDiagnostic(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  allowExec: boolean;
}): Promise<SecretRefEnvFallbackDiagnostic | null> {
  if (!isActiveGatewayTokenSurface(params.cfg, params.env)) {
    return null;
  }
  const tokenRef = resolveSecretInputRef({
    value: params.cfg.gateway?.auth?.token,
    defaults: params.cfg.secrets?.defaults,
  }).ref;
  if (!tokenRef) {
    return null;
  }
  // Preserve the existing --allow-exec contract: routine audit/doctor diagnostics must
  // not spawn command-backed SecretRef providers just to detect env fallback.
  if (tokenRef.source === "exec" && !params.allowExec) {
    return null;
  }
  const resolved = await resolveGatewayAuthToken({
    cfg: params.cfg,
    env: params.env,
    unresolvedReasonStyle: "detailed",
    envFallback: "always",
  });
  if (!resolved.secretRefConfigured || resolved.source !== "env" || !resolved.token) {
    return null;
  }
  return {
    code: "GATEWAY_AUTH_TOKEN_SECRETREF_ENV_FALLBACK",
    path: "gateway.auth.token",
    message:
      "gateway.auth.token SecretRef could not be resolved; runtime is using OPENCLAW_GATEWAY_TOKEN env fallback.",
  };
}

/** Collect SecretRef env-fallback diagnostics shared by security audit and doctor. */
export async function collectSecretRefEnvFallbackDiagnostics(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** When false (default), skip paths that would materialize exec SecretRef providers. */
  allowExec?: boolean;
}): Promise<SecretRefEnvFallbackDiagnostic[]> {
  const env = params.env ?? process.env;
  const allowExec = params.allowExec === true;
  const diagnostics: SecretRefEnvFallbackDiagnostic[] = [];

  const gatewayFallback = await collectGatewayAuthTokenEnvFallbackDiagnostic({
    cfg: params.cfg,
    env,
    allowExec,
  });
  if (gatewayFallback) {
    diagnostics.push(gatewayFallback);
  }

  // prepareSecretsRuntimeSnapshot resolves every SecretRef assignment, including exec.
  // Keep that materialization behind the same opt-in used by doctor/secrets audit.
  if (allowExec) {
    try {
      const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: params.cfg,
        env,
      });
      for (const warning of snapshot.warnings) {
        if (!RUNTIME_FALLBACK_WARNING_CODES.has(warning.code)) {
          continue;
        }
        diagnostics.push({
          code: warning.code,
          path: warning.path,
          message: warning.message,
        });
      }
    } catch {
      // Audit/doctor should stay best-effort when secrets preflight cannot run.
    }
  }

  return dedupeDiagnostics(diagnostics);
}
