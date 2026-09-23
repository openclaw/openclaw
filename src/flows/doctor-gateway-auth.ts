import { isRedactedSecretValue } from "../config/redact-sentinel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef, type SecretRef } from "../config/types.secrets.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import {
  isInvalidGatewaySecret,
  getTrustedProxyPasswordRedactionWarning,
} from "../gateway/known-weak-gateway-secrets.js";
import { getSkippedExecRefStaticError } from "../secrets/exec-resolution-policy.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

function buildGatewayTokenSecretRefUnavailableMessage(params: {
  cfg: OpenClawConfig;
  ref: SecretRef;
  unresolvedRefReason?: string;
}): string {
  if (params.unresolvedRefReason) {
    return `Gateway token SecretRef could not be resolved: ${params.unresolvedRefReason}`;
  }
  if (params.ref.source === "exec") {
    const staticError = getSkippedExecRefStaticError({ ref: params.ref, config: params.cfg });
    if (staticError) {
      return `Gateway token SecretRef could not be verified: ${staticError}`;
    }
    return "Gateway token SecretRef uses an exec provider and did not resolve.";
  }
  return "Gateway token is managed via SecretRef and is currently unavailable.";
}

function buildGatewayTokenSecretRefFixHint(ref: SecretRef): string {
  if (ref.source === "exec") {
    return "Run `openclaw doctor --allow-exec` to verify exec SecretRefs during doctor, or `openclaw secrets audit --allow-exec` to audit all exec SecretRefs.";
  }
  return "Resolve or rotate the external secret source, then rerun doctor.";
}

/** Shared auth diagnostics keep doctor's read-only and repair paths on the same policy. */
export async function detectGatewayAuthHealth(
  ctx: Pick<HealthCheckContext, "cfg" | "env" | "allowExecSecretRefs">,
): Promise<HealthFinding[]> {
  if (ctx.cfg.gateway?.mode === "remote") {
    return [];
  }
  const auth = resolveGatewayAuth({
    authConfig: ctx.cfg.gateway?.auth,
    tailscaleMode: ctx.cfg.gateway?.tailscale?.mode ?? "off",
    env: ctx.env,
  });
  const optionalPasswordWarning = getTrustedProxyPasswordRedactionWarning(auth);
  if (optionalPasswordWarning) {
    return [
      {
        checkId: "core/doctor/gateway-auth",
        severity: "warning",
        message: optionalPasswordWarning,
        path: "gateway.auth.password",
        fixHint:
          "Replace or remove the optional password; keep trusted-proxy authentication configured.",
      },
    ];
  }
  if (auth.mode !== "token") {
    return [];
  }
  const gatewayTokenRef = resolveSecretInputRef({
    value: ctx.cfg.gateway?.auth?.token,
    defaults: ctx.cfg.secrets?.defaults,
  }).ref;
  const invalidExecRef =
    gatewayTokenRef?.source === "exec" &&
    getSkippedExecRefStaticError({ ref: gatewayTokenRef, config: ctx.cfg });
  if (gatewayTokenRef?.source === "exec" && ctx.allowExecSecretRefs !== true && !invalidExecRef) {
    return [];
  }
  const resolved: Awaited<ReturnType<typeof resolveGatewayAuthToken>> = invalidExecRef
    ? { secretRefConfigured: true }
    : await resolveGatewayAuthToken({
        cfg: ctx.cfg,
        env: ctx.env ?? process.env,
        unresolvedReasonStyle: "detailed",
        ...(gatewayTokenRef ? { envFallback: "never" as const } : {}),
      });
  const redacted =
    resolved.unresolvedRefCode === "SECRET_REF_REDACTED_VALUE" ||
    isRedactedSecretValue(resolved.token) ||
    (!gatewayTokenRef && isRedactedSecretValue(ctx.cfg.gateway?.auth?.token));
  if (resolved.token && !isInvalidGatewaySecret(resolved.token) && !redacted) {
    return [];
  }
  if (gatewayTokenRef) {
    return [
      {
        checkId: "core/doctor/gateway-auth",
        severity: redacted ? "error" : "warning",
        ...(redacted ? { requirement: "SECRET_REF_REDACTED_VALUE" } : {}),
        message: buildGatewayTokenSecretRefUnavailableMessage({
          cfg: ctx.cfg,
          ref: gatewayTokenRef,
          unresolvedRefReason: isInvalidGatewaySecret(resolved.token)
            ? "the resolved token is blank or the literal string undefined/null"
            : resolved.unresolvedRefReason,
        }),
        path: "gateway.auth.token",
        fixHint:
          redacted && gatewayTokenRef.source === "store"
            ? `Run \`openclaw doctor --fix\` to regenerate secret store entry "${gatewayTokenRef.id}", then restart the Gateway and reconnect or re-pair devices with the new token.`
            : buildGatewayTokenSecretRefFixHint(gatewayTokenRef),
      },
    ];
  }
  const invalid =
    redacted ||
    isInvalidGatewaySecret(resolved.token) ||
    isInvalidGatewaySecret(ctx.cfg.gateway?.auth?.token);
  return [
    {
      checkId: "core/doctor/gateway-auth",
      severity: invalid ? "error" : "warning",
      message: redacted
        ? "Gateway token is a known redaction sentinel, not a usable secret."
        : invalid
          ? "Gateway token is blank or the literal string undefined/null, not a usable secret."
          : "Gateway auth is off or missing a token.",
      path: "gateway.auth.token",
      fixHint:
        "Run `openclaw doctor --fix --generate-gateway-token` to generate a token, then restart the Gateway.",
    },
  ];
}
