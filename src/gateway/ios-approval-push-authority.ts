import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig } from "../config/io.js";
import { withCurrentDevicePairingSnapshot } from "../infra/device-pairing-worker.js";
import { hasEffectivePairedDeviceRole, listDevicePairing } from "../infra/device-pairing.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { readOpenClawIdUserProfiles } from "../state/user-profile-openclaw-id.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import { prepareDeviceTokenBindingLookup } from "./openclaw-id/device-token-binding.js";
import {
  openclawIdTunnelRolePolicy,
  prepareOpenClawIdTunnelPrincipalLookup,
} from "./openclaw-id/tunnel-principal.js";
import { APPROVALS_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import {
  isApprovalRecordVisibleToClient,
  readApprovalRequestSource,
} from "./server-methods/approval-record-lookup.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "./session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "./session-sharing-read.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-target.types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

/** Prepare identity and session facts; the send continuation reads current owners. */
export async function prepareIosApprovalPushAuthority(record: ExecApprovalRecord<unknown>) {
  const [devicePeer, lookupPrincipal] = await Promise.all([
    prepareDeviceTokenBindingLookup(),
    prepareOpenClawIdTunnelPrincipalLookup(),
  ]);
  const source = readApprovalRequestSource(record);
  let session: SessionFactsRead<PreparedSessionMutationFacts> | undefined;
  let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
  try {
    const pairing = await listDevicePairing();
    const accounts = new Set<string>();
    for (const device of pairing.paired) {
      const peer = devicePeer(device.deviceId, "operator");
      const principal = peer ? lookupPrincipal(peer) : undefined;
      if (principal?.kind === "member") {
        accounts.add(principal.accountId);
      }
    }
    const profileVersion = readUserProfileVersion();
    const profiles = await readOpenClawIdUserProfiles([...accounts]);
    catalog = accounts.size ? await prepareUserProfileCatalog() : undefined;
    if (source.sessionKey && accounts.size) {
      const cfg = getRuntimeConfig();
      const { agentId } = resolveSessionStoreIdentity({
        cfg,
        sessionKey: source.sessionKey,
        agentId: source.agentId,
      });
      session = await prepareSessionMutationFacts({
        cfg,
        sessionKey: source.sessionKey,
        agentId,
        allowMissing: true,
      });
    }
    return {
      canSend: async (deviceId: string): Promise<boolean> => {
        return (
          (await withCurrentDevicePairingSnapshot(
            undefined,
            (paired) => ({
              start: () => {
                const device = paired.find((candidate) => candidate.deviceId === deviceId);
                const token = device?.tokens?.operator;
                if (
                  !device ||
                  !hasEffectivePairedDeviceRole(device, "operator") ||
                  !token ||
                  token.revokedAtMs
                ) {
                  return false;
                }
                const peer = devicePeer(deviceId, "operator");
                const principal = peer ? lookupPrincipal(peer) : undefined;
                if (peer && !principal) {
                  return false;
                }
                const policy = openclawIdTunnelRolePolicy(principal);
                const scopes = policy
                  ? intersectOperatorScopes(token.scopes, policy.scopes)
                  : token.scopes;
                if (
                  !roleScopesAllow({
                    role: "operator",
                    requestedScopes: [APPROVALS_SCOPE, READ_SCOPE],
                    allowedScopes: scopes,
                  })
                ) {
                  return false;
                }
                // An account link is attribution for session access, never a local-role fallback.
                const profileId =
                  principal?.kind === "member" ? profiles[principal.accountId]?.id : undefined;
                // Profile changes during preparation defer this push rather than reuse stale links.
                if (principal?.kind === "member" && readUserProfileVersion() !== profileVersion) {
                  return false;
                }
                const profile = profileId ? catalog?.readCurrentIdentity(profileId) : undefined;
                if (principal?.kind === "member" && !profile) {
                  return false;
                }
                const client: GatewayClient = {
                  ...(principal ? { internal: { openclawIdPrincipal: principal } } : {}),
                  preparedSessionProfile: profile,
                  ...(profile
                    ? {
                        authenticatedUserProfile: {
                          profileId: profile.profileId,
                          displayName: null,
                          hasAvatar: false,
                          updatedAt: 0,
                        },
                      }
                    : {}),
                  connect: {
                    minProtocol: 1,
                    maxProtocol: 1,
                    client: {
                      id: GATEWAY_CLIENT_IDS.IOS_APP,
                      version: "ios-push",
                      platform: "ios",
                      mode: GATEWAY_CLIENT_MODES.UI,
                    },
                    role: "operator",
                    scopes,
                    device: {
                      id: deviceId,
                      publicKey: "ios-push",
                      signature: "ios-push",
                      signedAt: 0,
                      nonce: "ios-push",
                    },
                  },
                };
                const cfg = getRuntimeConfig();
                const facts = principal ? session?.readCurrent(cfg) : undefined;
                return isApprovalRecordVisibleToClient({
                  record,
                  client,
                  // Unbound devices retain their independently approved local visibility.
                  ...(principal
                    ? {
                        cfg,
                        prepared: {
                          sharing: prepareProjectedSessionSharing({
                            cfg,
                            client,
                            isMember: (_target, identity) =>
                              facts?.membership.has(identity) ?? false,
                          }),
                          target: () => facts?.target ?? null,
                        },
                      }
                    : {}),
                });
              },
            }),
            async () => {
              await session?.prepareRead();
            },
          )) ?? false
        );
      },
      [Symbol.dispose]() {
        session?.release();
        catalog?.release();
      },
    };
  } catch (error) {
    session?.release();
    catalog?.release();
    throw error;
  }
}
