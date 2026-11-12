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
import { resolveGatewayAuth } from "../auth.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type AssertRuntimeSecurity = NonNullable<
  GatewayRequestContext["assertRuntimeSecurityConfigForWrite"]
>;

/** A token or password SecretRef whose provider has not answered yet; startup resolves it. */
function hasPendingCredentialRef(config: OpenClawConfig, resolvedConfig: OpenClawConfig): boolean {
  const auth = resolveGatewayAuth({
    authConfig: resolvedConfig.gateway?.auth,
    env: process.env,
    tailscaleMode: resolvedConfig.gateway?.tailscale?.mode,
  });
  return (
    (auth.mode === "token" || auth.mode === "password") &&
    !auth[auth.mode] &&
    Boolean(resolveSecretInputRef({ value: config.gateway?.auth?.[auth.mode] }).ref)
  );
}

/**
 * Rejects a write that changes Gateway auth into a state the serving Gateway would
 * refuse at its next reload or restart, which locks out the client that submitted it.
 * The Gateway's own startup and reload checks decide, so environment credentials,
 * `--auth`/`--password` overrides, a runtime-generated token and the listener's bind
 * all count. A refusal the saved config already had is not this write's doing: unrelated
 * writes, and edits that leave it in place, stay accepted.
 * Accepted edges: the checks use the current listener, so one write that changes auth
 * together with the bind or Tailscale mode is judged against the listener it replaces;
 * a SecretRef given as a startup override is not resolved here and does not count.
 */
export function unusableGatewayAuthChangeError(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  /** nextConfig with SecretRefs resolved by the write's secrets preparation. */
  resolvedNextConfig: OpenClawConfig;
  assertRuntimeSecurity: AssertRuntimeSecurity;
}): string | null {
  const previous = params.previousConfig.gateway;
  const next = params.nextConfig.gateway;
  if (
    (isDeepStrictEqual(previous?.auth, next?.auth) &&
      isDeepStrictEqual(previous?.trustedProxies, next?.trustedProxies)) ||
    hasPendingCredentialRef(params.nextConfig, params.resolvedNextConfig)
  ) {
    return null;
  }
  const refusal = (config: OpenClawConfig): string | null => {
    try {
      params.assertRuntimeSecurity(config);
      return null;
    } catch (error) {
      return formatErrorMessage(error);
    }
  };
  const reason = refusal(params.resolvedNextConfig);
  // The saved config is unresolved here: its SecretRef credential works at startup, so
  // removing it must not pass as a refusal that was already there.
  const savedReason = hasPendingCredentialRef(params.previousConfig, params.previousConfig)
    ? null
    : refusal(params.previousConfig);
  if (!reason || reason === savedReason) {
    return null;
  }
  return `Gateway authentication change rejected; the current settings were kept: ${reason}`;
}

/**
 * Resolves the submitted config's secrets the way the Gateway will, then refuses
 * submissions whose gateway auth would leave no client able to connect.
 */
export async function prepareConfigWriteSecretsOrRespond(
  context: Pick<GatewayRequestContext, "assertRuntimeSecurityConfigForWrite">,
  params: { previousConfig: OpenClawConfig; config: OpenClawConfig; respond: RespondFn },
): Promise<PreparedSecretsRuntimeSnapshot | null> {
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
  const assertRuntimeSecurity = context.assertRuntimeSecurityConfigForWrite;
  const authError =
    assertRuntimeSecurity &&
    unusableGatewayAuthChangeError({
      previousConfig: params.previousConfig,
      nextConfig: params.config,
      resolvedNextConfig: snapshot.config,
      assertRuntimeSecurity,
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
