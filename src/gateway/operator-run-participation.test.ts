import { expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createTestOperatorAuthority } from "../agents/admitted-run-context.test-support.js";
import type { BoundParticipationCeiling } from "../agents/participation-ceiling.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { captureGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.js";
import { withRecovery } from "./operator-run-recovery.test-support.js";

const bound: BoundParticipationCeiling = {
  kind: "send",
  profileId: "participant",
  sessionKey: "agent:main:invited",
  tools: ["read"],
  permission: "read-only",
  source: {
    agentId: "main",
    sessionId: "invited",
    lifecycleRevision: null,
    creatorProfileId: "creator",
    root: "/invited",
  },
};

it("captures a principal-ingress participant with the same strict durable dialect", () =>
  withRecovery(async (fixture, _root, profile) => {
    const identity = await prepareUserProfileIdentity(profile.id);
    try {
      const authority = createTestOperatorAuthority({
        canonicalIdentity: null,
        profileId: profile.id,
        scopes: ["operator.sessions.read"],
        gatewayAccessGrant: null,
        participationCeiling: { ...bound, profileId: profile.id },
      });
      const snapshot = await captureGatewayOperatorRecoverySnapshot({
        authority,
        identity,
        config: fixture.context.getRuntimeConfig(),
        modelPolicy: undefined,
        client: {
          ...fixture.client,
          internal: {
            ...fixture.client.internal,
            remoteIngressPrincipal: {
              bindingId: "fixture",
              pluginId: "fixture",
              audienceId: "audience",
              principal: { kind: "person", profileId: profile.id },
              authenticatedUserProfile: {
                profileId: profile.id,
                displayName: null,
                avatarRevision: "0",
                hasAvatar: false,
                updatedAt: 1,
              },
              preparedSessionProfile: {
                profileId: profile.id,
                role: null,
                aliases: new Set(["recovery@example.test"]),
              },
              operatorRoleActor: { kind: "operator", profileId: profile.id },
              scopes: [...authority.scopes],
              signal: new AbortController().signal,
              assertCurrent() {},
              recoverySource: {
                pluginId: "fixture",
                audienceId: "audience",
                recoveryId: "original",
              },
            },
          },
        },
      });
      expect(
        createAdmittedRunOperatorAuthority({ ...authority, recoverySnapshot: snapshot.snapshot })
          .recoverySnapshot,
      ).toMatchObject({
        version: 2,
        sourceIngress: "principal",
        participationCeiling: authority.participationCeiling,
      });
    } finally {
      identity.release();
    }
  }));
