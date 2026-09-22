import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withCurrentDevicePairingSnapshot } from "../infra/device-pairing-worker.js";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import { withBoundWebPushSubscriptions, type BoundWebPushSubscription } from "../infra/push-web.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";

const OPERATOR_ROLE = "operator";

export type CurrentWebPushTarget = {
  subscription: BoundWebPushSubscription;
  scopes: string[];
  userProfileId: string | null;
};

function resolveCurrentWebPushTarget(params: {
  subscription: BoundWebPushSubscription;
  device: PairedDevice | undefined;
  cfg: OpenClawConfig;
  requiredScopes: readonly string[];
  visibilityScopes?: readonly string[];
}): CurrentWebPushTarget | null {
  const { device, subscription, cfg } = params;
  if (!device || !hasEffectivePairedDeviceRole(device, OPERATOR_ROLE)) {
    return null;
  }
  const operatorToken = device.tokens?.[OPERATOR_ROLE];
  const approvedScopes = device.approvedScopes ?? device.scopes;
  if (
    !operatorToken ||
    operatorToken.revokedAtMs ||
    !approvedScopes ||
    !roleScopesAllow({
      role: OPERATOR_ROLE,
      requestedScopes: operatorToken.scopes,
      allowedScopes: approvedScopes,
    })
  ) {
    return null;
  }

  const storedProfileId = subscription.userProfileId;
  const userProfileId = storedProfileId ? (resolveUserProfileId(storedProfileId) ?? null) : null;
  if ((storedProfileId && !userProfileId) || (cfg.gateway?.roles && !userProfileId)) {
    return null;
  }
  const rolePolicy = userProfileId
    ? resolveOperatorRolePolicyForProfile(userProfileId, cfg)
    : undefined;
  if (cfg.gateway?.roles && !rolePolicy) {
    return null;
  }
  const scopesAllowed = (requestedScopes: readonly string[]) =>
    roleScopesAllow({
      role: OPERATOR_ROLE,
      requestedScopes,
      allowedScopes: operatorToken.scopes,
    }) &&
    (!rolePolicy ||
      roleScopesAllow({
        role: OPERATOR_ROLE,
        requestedScopes,
        allowedScopes: rolePolicy.scopes,
      }));
  if (!scopesAllowed(params.requiredScopes)) {
    return null;
  }
  // Only targeted callers request extra visibility. Both current authorities must
  // grant it; generic pushes retain their deliberately narrow required scopes.
  const visibilityScopes = rolePolicy
    ? (params.visibilityScopes ?? []).filter((scope) => scopesAllowed([scope]))
    : [];
  return {
    subscription,
    scopes: [...new Set([...params.requiredScopes, ...visibilityScopes])],
    userProfileId,
  };
}

/** Resolve current recipients from the pairing owner's prepared authority facts. */
export function listCurrentWebPushTargets(params: {
  cfg: OpenClawConfig;
  requiredScopes: readonly string[];
  visibilityScopes?: readonly string[];
  pairedDevices: readonly PairedDevice[];
  subscriptions: readonly BoundWebPushSubscription[];
}): CurrentWebPushTarget[] {
  const pairedByDeviceId = new Map(params.pairedDevices.map((device) => [device.deviceId, device]));
  return params.subscriptions.flatMap((subscription) => {
    const target = resolveCurrentWebPushTarget({
      subscription,
      device: pairedByDeviceId.get(subscription.deviceId),
      cfg: params.cfg,
      requiredScopes: params.requiredScopes,
      visibilityScopes: params.visibilityScopes,
    });
    return target ? [target] : [];
  });
}

/** Keep both binding and pairing authority until the synchronous provider start. */
export function withCurrentWebPushAuthority<T>(
  stateDir: string | undefined,
  prepare: (
    subscriptions: BoundWebPushSubscription[],
    pairedDevices: readonly PairedDevice[],
  ) => { start: () => T | Promise<T> } | undefined,
): Promise<T | undefined> {
  return withBoundWebPushSubscriptions(stateDir, async (subscriptions, assertCurrent) => {
    const begun = await withCurrentDevicePairingSnapshot(stateDir, (pairedDevices) => {
      const action = prepare(subscriptions, pairedDevices);
      return {
        start: () => {
          assertCurrent();
          // Boxing lets both storage scopes release after start without retaining provider I/O.
          return { value: action?.start() };
        },
      };
    });
    return begun ? { start: () => begun.value } : undefined;
  });
}

export function webPushTargetClient(target: CurrentWebPushTarget): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "web-push",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      device: {
        id: target.subscription.deviceId,
        publicKey: "web-push",
        signature: "web-push",
        signedAt: 0,
        nonce: "web-push",
      },
      role: OPERATOR_ROLE,
      scopes: target.scopes,
    },
    ...(target.userProfileId
      ? {
          authenticatedUserProfile: {
            profileId: target.userProfileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 0,
          },
        }
      : {}),
  };
}
