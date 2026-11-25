import { afterEach } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { createGatewayBroadcaster } from "./server-broadcast.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { resolveSessionSharingRole } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import {
  canReceiveSessionEvent,
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "./session-sharing-read.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

const profileSubscriptions = new Set<() => void>();
afterEach(() => {
  for (const stop of profileSubscriptions) {
    stop();
  }
  profileSubscriptions.clear();
});

export function sharingPolicyClient(params: {
  user?: string;
  deviceId?: string;
  displayName?: string;
  githubSyncPending?: boolean;
  scopes?: string[];
}): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
        ...(params.displayName ? { displayName: params.displayName } : {}),
      },
      role: "operator",
      scopes: params.scopes ?? ["operator.read", "operator.write"],
      ...(params.deviceId
        ? {
            device: {
              id: params.deviceId,
              publicKey: "key",
              signature: "signature",
              signedAt: 1,
              nonce: "nonce",
            },
          }
        : {}),
    },
    ...(params.user
      ? {
          authenticatedUserId: params.user,
          authenticatedUserProfile: {
            profileId: params.user,
            displayName: params.displayName ?? null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
    ...(params.githubSyncPending
      ? {
          authenticatedGitHubIdentitySync: async () => ({ profileId: "pending", updatedAt: 1 }),
        }
      : {}),
  };
}

export function rolePolicyConfig(writeAgents: "*" | string[] = "*"): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "view",
        definitions: {
          none: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          invited: {
            sessions: { others: "invited" },
            agents: "*",
            scopes: ["operator.read", "operator.write", "operator.sessions.write"],
          },
          view: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          suggest: {
            sessions: { others: "suggest" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          write: {
            sessions: { others: "write" },
            agents: writeAgents,
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
}

export function roleClient(
  role: "none" | "invited" | "view" | "suggest" | "write",
  label: string = role,
): GatewayClient {
  const profile = ensureProfileForEmail(`${label}@example.test`);
  setUserProfileRole(profile.id, role);
  const client = sharingPolicyClient({ user: profile.id }) as GatewayWsClient;
  const refresh = () => prepareGatewayRecipientProfile(client);
  refresh();
  profileSubscriptions.add(onUserProfilesChanged(refresh));
  return client;
}

export async function canReceivePreparedSessionEvent(
  params: Omit<Parameters<typeof canReceiveSessionEvent>[0], "prepared">,
): Promise<boolean> {
  const reads = [];
  try {
    for (const sessionKey of params.sessionKeys) {
      const { agentId } = resolveSessionStoreIdentity({
        cfg: params.cfg,
        sessionKey,
        agentId: params.agentId,
      });
      reads.push({
        sessionKey,
        read: await prepareSessionMutationFacts({
          cfg: params.cfg,
          sessionKey,
          agentId,
          allowMissing: true,
        }),
      });
    }
    const facts = new Map(
      reads.map(({ sessionKey, read }) => [sessionKey, read.readCurrent(params.cfg)]),
    );
    const sharing = prepareProjectedSessionSharing({
      cfg: params.policyConfig ?? params.cfg,
      client: params.client,
      profiles: await prepareSessionSharingProfiles(params.client),
      isMember: (target, identityId) =>
        [...facts.values()].some(
          (fact) =>
            fact.target?.storePath === target.storePath &&
            fact.target?.storeKey === target.storeKey &&
            fact.membership.has(identityId),
        ),
    });
    return canReceiveSessionEvent({
      ...params,
      prepared: { sharing, target: (sessionKey) => facts.get(sessionKey)?.target ?? null },
    });
  } finally {
    for (const { read } of reads) {
      read.release();
    }
  }
}

export function createProjectedSessionEventPredicate(
  cfg: OpenClawConfig,
  projection: Pick<SessionRowProjection, "hasMembership" | "sharingTarget">,
): NonNullable<Parameters<typeof createGatewayBroadcaster>[0]["canReceiveSessionEvent"]> {
  return (client, sessionKeys, agentId, event, payload) =>
    canReceiveSessionEvent({
      cfg,
      client,
      sessionKeys,
      agentId,
      event,
      payload,
      prepared: {
        sharing: prepareProjectedSessionSharing({
          cfg,
          client,
          isMember: (target, identityId) =>
            projection.hasMembership(target.storePath, target.storeKey, identityId),
        }),
        target: (key, targetAgentId) => {
          const { agentId: ownerAgentId } = resolveSessionStoreIdentity({
            cfg,
            sessionKey: key,
            agentId: targetAgentId,
          });
          return projection.sharingTarget({ key, agentId: ownerAgentId });
        },
      },
    });
}

type SharingTarget = Parameters<typeof resolveSessionSharingRole>[0]["target"];

export function sharingPolicyTarget(createdActor?: {
  type: "human";
  id: string;
  label?: string;
}): SharingTarget {
  return {
    agentId: "main",
    canonicalKey: "agent:main:main",
    entry: {
      sessionId: "session-main",
      updatedAt: 1,
      visibility: "draft",
      ...(createdActor
        ? {
            createdVia: "operator" as const,
            createdActor: { ...createdActor, source: "profile" as const },
          }
        : {}),
    },
    storeKey: "agent:main:main",
    storeKeys: ["agent:main:main"],
    storePath: "/tmp/sessions.json",
  };
}
