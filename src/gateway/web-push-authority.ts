import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withCurrentDevicePairingSnapshot } from "../infra/device-pairing-worker.js";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import {
  WEB_PUSH_USER_PREFERENCES_KEY,
  resolveEffectiveWebPushPreferences,
} from "../infra/push-web-preferences.js";
import { withBoundWebPushSubscriptions, type BoundWebPushSubscription } from "../infra/push-web.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getUserPreferenceValues } from "../state/user-preferences.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "./session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "./session-sharing-read.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

const OPERATOR_ROLE = "operator";

export type CurrentWebPushTarget = {
  subscription: BoundWebPushSubscription;
  scopes: string[];
  userProfileId: string | null;
  profile: GatewayClient["preparedSessionProfile"];
  preferences: ReturnType<typeof resolveEffectiveWebPushPreferences>;
};

export type WebPushAuthority = {
  cfg: OpenClawConfig;
  subscriptions: readonly BoundWebPushSubscription[];
  pairedDevices: readonly PairedDevice[];
  profile: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
  preferences: Map<string, unknown>;
  sessions: Map<string, PreparedSessionMutationFacts>;
};

function resolveCurrentWebPushTarget(params: {
  subscription: BoundWebPushSubscription;
  device: PairedDevice | undefined;
  cfg: OpenClawConfig;
  requiredScopes: readonly string[];
  visibilityScopes?: readonly string[];
  profile: GatewayClient["preparedSessionProfile"];
  preferences: Map<string, unknown>;
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
  const userProfileId = params.profile?.profileId ?? null;
  if ((storedProfileId && !userProfileId) || (cfg.gateway?.roles && !userProfileId)) {
    return null;
  }
  const rolePolicy = userProfileId
    ? resolveOperatorRolePolicyForAssignment(userProfileId, params.profile?.role ?? null, cfg)
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
    profile: params.profile,
    preferences: resolveEffectiveWebPushPreferences({
      user: userProfileId ? params.preferences.get(userProfileId) : undefined,
      device: subscription.devicePreferences,
    }),
  };
}

/** Resolve current recipients from the pairing owner's prepared authority facts. */
export function listCurrentWebPushTargets(
  params: WebPushAuthority & {
    requiredScopes: readonly string[];
    visibilityScopes?: readonly string[];
  },
): CurrentWebPushTarget[] {
  const pairedByDeviceId = new Map(params.pairedDevices.map((device) => [device.deviceId, device]));
  return params.subscriptions.flatMap((subscription) => {
    const target = resolveCurrentWebPushTarget({
      subscription,
      device: pairedByDeviceId.get(subscription.deviceId),
      cfg: params.cfg,
      requiredScopes: params.requiredScopes,
      visibilityScopes: params.visibilityScopes,
      profile: subscription.userProfileId
        ? params.profile?.readCurrentIdentity(subscription.userProfileId)
        : undefined,
      preferences: params.preferences,
    });
    return target ? [target] : [];
  });
}

/** Keep both binding and pairing authority until the synchronous provider start. */
export function withCurrentWebPushAuthority<T>(
  params: {
    stateDir?: string;
    getRuntimeConfig: () => OpenClawConfig;
    sessionKeys?: readonly string[];
    agentId?: string;
  },
  prepare: (authority: WebPushAuthority) => { start: () => T | Promise<T> } | undefined,
): Promise<T | undefined> {
  return withBoundWebPushSubscriptions(params.stateDir, async (subscriptions, assertCurrent) => {
    const options = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    const profile = subscriptions.some((subscription) => subscription.userProfileId)
      ? await prepareUserProfileCatalog(options)
      : undefined;
    const sessions = new Map<string, SessionFactsRead<PreparedSessionMutationFacts>>();
    try {
      for (const sessionKey of new Set(params.sessionKeys)) {
        const cfg = params.getRuntimeConfig();
        const { agentId } = resolveSessionStoreIdentity({
          cfg,
          sessionKey,
          agentId: params.agentId,
        });
        sessions.set(
          sessionKey,
          await prepareSessionMutationFacts({ cfg, sessionKey, agentId, allowMissing: true }),
        );
      }
      // Pairing preparation can yield after a profile merge or preference mutation.
      for (;;) {
        const profileIds = new Set(
          subscriptions.flatMap((subscription) => {
            const id =
              subscription.userProfileId &&
              profile?.readCurrentIdentity(subscription.userProfileId)?.profileId;
            return id ? [id] : [];
          }),
        );
        const preferences = await getUserPreferenceValues(
          [...profileIds],
          WEB_PUSH_USER_PREFERENCES_KEY,
          options,
        );
        let changed = false;
        const begun = await withCurrentDevicePairingSnapshot(params.stateDir, (pairedDevices) => {
          assertCurrent();
          changed =
            !preferences.isCurrent() ||
            subscriptions.some((subscription) => {
              const id =
                subscription.userProfileId &&
                profile?.readCurrentIdentity(subscription.userProfileId)?.profileId;
              return id && !profileIds.has(id);
            });
          if (changed) {
            return undefined;
          }
          const cfg = params.getRuntimeConfig();
          const action = prepare({
            cfg,
            subscriptions,
            pairedDevices,
            profile,
            preferences: preferences.values,
            sessions: new Map([...sessions].map(([key, facts]) => [key, facts.readCurrent(cfg)])),
          });
          return {
            start: () => {
              assertCurrent();
              // Boxing releases storage and profile leases without retaining provider I/O.
              return { value: action?.start() };
            },
          };
        });
        if (!changed) {
          return begun ? { start: () => begun.value } : undefined;
        }
      }
    } finally {
      profile?.release();
      for (const facts of sessions.values()) {
        facts.release();
      }
    }
  });
}

export function webPushSessionAccess(authority: WebPushAuthority, client: GatewayClient) {
  return {
    sharing: prepareProjectedSessionSharing({
      cfg: authority.cfg,
      client,
      isMember: (target, identity) =>
        [...authority.sessions.values()].some(
          (facts) => facts.target === target && facts.membership.has(identity),
        ),
    }),
    target: (sessionKey: string) => authority.sessions.get(sessionKey)?.target ?? null,
  };
}

export function webPushTargetClient(target: CurrentWebPushTarget): GatewayClient {
  return {
    preparedSessionProfile: target.profile,
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
