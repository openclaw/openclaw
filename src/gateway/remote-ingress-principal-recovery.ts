import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  GatewayDispatchUnavailableError,
  GatewayOperatorRecoveryAuthorizationError,
} from "../infra/restart-recovery-errors.js";
import type { GatewayIngressPrincipalRecovery } from "../plugins/gateway-ingress.types.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

type Owner = {
  resume: GatewayIngressPrincipalRecovery;
  signal: AbortSignal;
  assertCurrent(): void;
};
// Routing only: the plugin's canonical grant owner makes every authorization decision.
const owners = new WeakMap<GatewayRequestContext, Map<string, Owner>>();

export function registerIngressPrincipalRecovery(
  context: GatewayRequestContext,
  pluginId: string,
  owner: Owner,
): void {
  owner.signal.throwIfAborted();
  owner.assertCurrent();
  let registry = owners.get(context);
  if (!registry) {
    registry = new Map();
    owners.set(context, registry);
  }
  registry.set(pluginId, owner);
  owner.signal.addEventListener(
    "abort",
    () => {
      if (registry.get(pluginId) === owner) {
        registry.delete(pluginId);
      }
    },
    { once: true },
  );
}

/** Capture only audiences the owner can actually reconstruct, not ephemeral consent handles. */
export async function captureIngressPrincipalRecovery(
  context: GatewayRequestContext,
  source: { pluginId: string; audienceId: string },
  profileId: string,
  scopes: readonly string[],
) {
  if (!owners.get(context)?.has(source.pluginId)) {
    return undefined;
  }
  try {
    const restored = await restoreIngressPrincipalRecovery(context, source, profileId, scopes);
    return { ...source, recoveryId: restored.recoveryId };
  } catch {
    // Optional recovery must not reject a valid interactive grant. Scheduling
    // reports missing durable custody; restoration itself remains fail-closed.
    return undefined;
  }
}

export async function restoreIngressPrincipalRecovery(
  context: GatewayRequestContext,
  source: { pluginId: string; audienceId: string; recoveryId?: string },
  profileId: string,
  scopes: readonly string[],
) {
  const owner = owners.get(context)?.get(source.pluginId);
  if (!owner) {
    throw new GatewayDispatchUnavailableError(
      "ingress principal recovery (owner unavailable)",
      true,
    );
  }
  owner.assertCurrent();
  const grant = await owner.resume(source.audienceId).catch(() => {
    throw new GatewayDispatchUnavailableError(
      "ingress principal recovery (grant store unavailable)",
      true,
    );
  });
  if (!grant) {
    throw new GatewayOperatorRecoveryAuthorizationError(
      "The original ingress grant is no longer available.",
    );
  }
  const assertCurrent = () => {
    owner.signal.throwIfAborted();
    owner.assertCurrent();
    if (owners.get(context)?.get(source.pluginId) !== owner) {
      throw new GatewayDispatchUnavailableError("ingress principal recovery (owner changed)", true);
    }
    grant.signal.throwIfAborted();
    grant.assertCurrent();
    const currentProfile =
      grant.principal.kind === "owner" ? GATEWAY_OWNER_PROFILE_ID : grant.principal.profileId;
    if (
      grant.audienceId !== source.audienceId ||
      (source.recoveryId !== undefined && grant.recoveryId !== source.recoveryId) ||
      currentProfile !== profileId ||
      !roleScopesAllow({
        role: "operator",
        requestedScopes: scopes,
        allowedScopes: grant.operatorScopeCeiling,
      })
    ) {
      throw new GatewayOperatorRecoveryAuthorizationError(
        "The original ingress grant identity or scope ceiling changed.",
      );
    }
  };
  assertCurrent();
  return {
    assertCurrent,
    signal: AbortSignal.any([owner.signal, grant.signal]),
    recoveryId: grant.recoveryId,
  };
}
