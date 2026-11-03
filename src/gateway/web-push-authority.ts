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

/** Resolve current recipients from the pairing owner's prepared authority facts. */
export function listCurrentWebPushTargets(
  params: WebPushAuthority & {
    requiredScopes: readonly string[];
    visibilityScopes?: readonly string[];
  },
): CurrentWebPushTarget[] {
  const pairedByDeviceId = new Map(params.pairedDevices.map((device) => [device.deviceId, device]));
  return params.subscriptions.flatMap((subscription) => {
    const device = pairedByDeviceId.get(subscription.deviceId);
    const { cfg, requiredScopes, visibilityScopes: requestedVisibilityScopes } = params;
    const profile = subscription.userProfileId
      ? params.profile?.readCurrentIdentity(subscription.userProfileId)
      : undefined;
    const preferences = params.preferences;
    if (!device || !hasEffectivePairedDeviceRole(device, OPERATOR_ROLE)) {
      return [];
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
      return [];
    }

    const storedProfileId = subscription.userProfileId;
    const userProfileId = profile?.profileId ?? null;
    if ((storedProfileId && !userProfileId) || (cfg.gateway?.roles && !userProfileId)) {
      return [];
    }
    const rolePolicy = userProfileId
      ? resolveOperatorRolePolicyForAssignment(
          userProfileId,
          profile?.role ?? null,
          cfg,
          profile?.githubLogin ?? null,
        )
      : undefined;
    if (cfg.gateway?.roles && !rolePolicy) {
      return [];
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
    if (!scopesAllowed(requiredScopes)) {
      return [];
    }
    // Only targeted callers request extra visibility. Both current authorities must
    // grant it; generic pushes retain their deliberately narrow required scopes.
    const visibilityScopes = rolePolicy
      ? (requestedVisibilityScopes ?? []).filter((scope) => scopesAllowed([scope]))
      : [];
    return [
      {
        subscription,
        scopes: [...new Set([...requiredScopes, ...visibilityScopes])],
        userProfileId,
        profile,
        preferences: resolveEffectiveWebPushPreferences({
          user: userProfileId ? preferences.get(userProfileId) : undefined,
          device: subscription.devicePreferences,
        }),
      },
    ];
  });
}

/** Keep both binding and pairing authority until the synchronous provider start. */
export async function withCurrentWebPushAuthority<T>(
  params: {
    stateDir?: string;
    getRuntimeConfig: () => OpenClawConfig;
    sessionKeys?: readonly string[];
    agentId?: string;
    preparePublication?: () => Promise<void>;
  },
  prepare: (authority: WebPushAuthority) => { start: () => T | Promise<T> } | undefined,
): Promise<T | undefined> {
  const sessions = new Map<string, SessionFactsRead<PreparedSessionMutationFacts>>();
  try {
    // Session discovery can wait on another store; keep browser registration outside that wait.
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
    const delivery = await withBoundWebPushSubscriptions(
      params.stateDir,
      async (subscriptions, assertCurrent) => {
        const options = params.stateDir
          ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
          : {};
        const profile = subscriptions.some((subscription) => subscription.userProfileId)
          ? await prepareUserProfileCatalog(options)
          : undefined;
        try {
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
            const begun = await withCurrentDevicePairingSnapshot(
              params.stateDir,
              (pairedDevices) => {
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
                  sessions: new Map(
                    [...sessions].map(([key, facts]) => [key, facts.readCurrent(cfg)]),
                  ),
                });
                return {
                  start: () => {
                    assertCurrent();
                    // Boxing releases storage and profile leases without retaining provider I/O.
                    return { value: action?.start() };
                  },
                };
              },
              sessions.size > 0
                ? async () => {
                    if (params.preparePublication) {
                      await params.preparePublication();
                    }
                    // Session writes can begin while pairing loads; join their publication before
                    // the final synchronous access check, without retaining facts through provider I/O.
                    await Promise.all(
                      [...sessions.values()].flatMap((facts) => facts.prepareRead() ?? []),
                    );
                  }
                : params.preparePublication,
            );
            if (!changed) {
              return begun ? { start: () => begun } : undefined;
            }
          }
        } finally {
          profile?.release();
        }
      },
    );
    // Release session facts before awaiting provider completion.
    return delivery?.value;
  } finally {
    for (const facts of sessions.values()) {
      facts.release();
    }
  }
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
