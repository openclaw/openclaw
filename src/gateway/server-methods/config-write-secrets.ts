import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSecretInputRef } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isRetryableSecretDegradationReason,
  redactSecretDegradationReason,
} from "../../secrets/runtime-degraded-state.js";
import {
  prepareSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import { assertGatewayAuthConfigured, resolveGatewayAuth } from "../auth.js";
import type { RespondFn } from "./types.js";

/** Startup's own auth checks for one config, as a message, or null when a client can connect. */
function gatewayAuthUnusableReason(params: {
  config: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
}): string | null {
  const auth = resolveGatewayAuth({
    authConfig: params.resolvedConfig.gateway?.auth,
    env: process.env,
    tailscaleMode: params.resolvedConfig.gateway?.tailscale?.mode,
  });
  const authored = params.config.gateway?.auth;
  // A SecretRef the write already resolved through its owner counts as configured.
  if (
    (auth.mode === "token" || auth.mode === "password") &&
    !auth[auth.mode] &&
    resolveSecretInputRef({ value: authored?.[auth.mode] }).ref
  ) {
    return null;
  }
  try {
    assertGatewayAuthConfigured(auth, authored);
  } catch (error) {
    return formatErrorMessage(error);
  }
  if (auth.mode === "trusted-proxy" && !params.resolvedConfig.gateway?.trustedProxies?.length) {
    return "gateway auth mode is trusted-proxy, but gateway.trustedProxies lists no proxy IP";
  }
  return null;
}

/**
 * Rejects a write that changes Gateway auth into a state nobody can connect with.
 * Startup and reload run the same checks only after the file is persisted, which
 * locks out the client that submitted it. Unrelated writes, and edits that keep an
 * already-incomplete mode (such as a runtime-generated token), stay accepted.
 * Environment credentials count (`--token` arrives as OPENCLAW_GATEWAY_TOKEN);
 * `--auth`/`--password` startup overrides are not visible here, so a file-only
 * switch that relies on them is rejected with the missing setting named.
 */
export function unusableGatewayAuthChangeError(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  /** nextConfig with SecretRefs resolved by the write's secrets preparation. */
  resolvedNextConfig: OpenClawConfig;
}): string | null {
  const previous = params.previousConfig.gateway;
  const next = params.nextConfig.gateway;
  if (
    isDeepStrictEqual(previous?.auth, next?.auth) &&
    isDeepStrictEqual(previous?.trustedProxies, next?.trustedProxies)
  ) {
    return null;
  }
  const nextReason = gatewayAuthUnusableReason({
    config: params.nextConfig,
    resolvedConfig: params.resolvedNextConfig,
  });
  if (!nextReason) {
    return null;
  }
  const previousReason = gatewayAuthUnusableReason({
    config: params.previousConfig,
    resolvedConfig: params.previousConfig,
  });
  const modeOf = (config: OpenClawConfig) =>
    resolveGatewayAuth({
      authConfig: config.gateway?.auth,
      env: process.env,
      tailscaleMode: config.gateway?.tailscale?.mode,
    }).mode;
  if (previousReason && modeOf(params.previousConfig) === modeOf(params.nextConfig)) {
    return null;
  }
  return `Gateway authentication change rejected; the current settings were kept: ${nextReason}`;
}

/**
 * Resolves the submitted config's secrets the way the Gateway will, then refuses
 * submissions whose gateway auth would leave no client able to connect.
 */
export async function prepareConfigWriteSecretsOrRespond(params: {
  previousConfig: OpenClawConfig;
  config: OpenClawConfig;
  respond: RespondFn;
}): Promise<PreparedSecretsRuntimeSnapshot | null> {
  let snapshot: PreparedSecretsRuntimeSnapshot;
  try {
    snapshot = await prepareSecretsRuntimeSnapshot({
      config: params.config,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
    });
    for (const owner of snapshot.degradedOwners ?? []) {
      const reason = redactSecretDegradationReason(owner.reason);
      if (!isRetryableSecretDegradationReason(reason)) {
        throw new Error(reason);
      }
    }
  } catch (error) {
    const details = formatErrorMessage(error);
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid config: active SecretRef resolution failed (${details})`,
      ),
    );
    return null;
  }
  const authError = unusableGatewayAuthChangeError({
    previousConfig: params.previousConfig,
    nextConfig: params.config,
    resolvedNextConfig: snapshot.config,
  });
  if (authError) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, authError, {
        details: { reason: "gateway-auth-unusable" },
      }),
    );
    return null;
  }
  return snapshot;
}

export function preparedSecretDegradationPayload(snapshot: PreparedSecretsRuntimeSnapshot) {
  const degradedSecretOwners = (snapshot.degradedOwners ?? []).map((owner) => ({
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    state: owner.degradationState ?? "cold",
    paths: [...owner.paths],
    reason: redactSecretDegradationReason(owner.reason),
  }));
  return degradedSecretOwners.length > 0 ? { degradedSecretOwners } : {};
}
