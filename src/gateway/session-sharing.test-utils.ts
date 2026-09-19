import { afterEach } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

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
  role: "none" | "view" | "suggest" | "write",
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
