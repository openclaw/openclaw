import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createTestOperatorAuthority } from "../agents/admitted-run-context.test-support.js";
import {
  participationAllowsTool,
  type BoundParticipationCeiling,
} from "../agents/participation-ceiling.js";
import { patchSessionEntryCore, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import { retainGatewayOperatorInvocation } from "./operator-run-invocation.js";
import { normalizeGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import { captureGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import { withRecovery } from "./operator-run-recovery.test-support.js";
import { prepareSessionDelegatedOperatorAuthority } from "./session-delegated-operator-source.js";

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

it("narrows same-role invitation fields on recovery without widening retained work", () =>
  withRecovery(
    async (fixture) => {
      const creator = ensureProfileForEmail("original-creator@example.test");
      const target = {
        ...fixture.target,
        sessionKey: "agent:main:participant-policy",
        sessionId: "participant-policy",
      };
      await replaceSessionEntry(target, {
        ...fixture.entry,
        sessionId: target.sessionId,
        parentSessionKey: undefined,
        visibility: "shared",
        sessionRoot: "/invited",
        createdActor: { type: "human", source: "profile", id: creator.id },
      });
      await addSessionMember(target, {
        identityId: fixture.snapshot.profileId,
        addedBy: creator.id,
        access: "send",
      });
      const ceiling: BoundParticipationCeiling = {
        ...bound,
        profileId: fixture.snapshot.profileId,
        sessionKey: target.sessionKey,
        permission: "workspace",
        tools: ["read", "exec"],
        source: {
          ...bound.source,
          sessionId: target.sessionId,
          lifecycleRevision: fixture.entry.lifecycleRevision ?? null,
          creatorProfileId: creator.id,
        },
      };
      const snapshot = expectDefined(
        normalizeGatewayOperatorRecoverySnapshot({
          ...fixture.snapshot,
          version: 2,
          participationCeiling: ceiling,
        }),
        "participant snapshot",
      );
      const restore = (source = snapshot) =>
        restoreGatewayOperatorSource({
          snapshot: source,
          context: fixture.context,
          assertCurrent() {},
        });
      const original = await restore();
      try {
        for (const different of [false, true]) {
          const current = createAdmittedRunOperatorAuthority({
            ...original.authority,
            participationCeiling: {
              ...ceiling,
              tools: ["*"],
              permission: "full",
              ...(different ? { source: { ...ceiling.source, root: "/other" } } : {}),
            },
          });
          const derive = () =>
            retainGatewayOperatorInvocation(
              { authority: original.authority, release() {} },
              { participationAuthority: current, assertCurrent() {} },
            );
          if (different) {
            expect(derive).toThrow("one original invitation");
          } else {
            const derived = derive();
            expect(derived.authority.participationCeiling).toEqual({
              ...original.authority.participationCeiling,
              toolConstraints: [["*"]],
            });
            derived.release();
          }
        }

        const child = await prepareSessionDelegatedOperatorAuthority({
          context: fixture.context,
          agentId: "main",
          entry: {
            sessionId: "delegated-child",
            updatedAt: 1,
            delegatedOperatorSource: { kind: "gateway", snapshot },
          },
          authority: createTestOperatorAuthority({
            canonicalIdentity: null,
            profileId: "different-admin",
            scopes: ["operator.admin"],
          }),
        });
        expect(child?.authority.profileId).toBe(fixture.snapshot.profileId);
        expect(child?.authority.recoverySnapshot?.profileId).toBe(fixture.snapshot.profileId);
        expect(child?.authority.participationCeiling).toEqual(
          original.authority.participationCeiling,
        );
        child?.release();
        const narrow = structuredClone(fixture.context.getRuntimeConfig());
        narrow.gateway!.roles!.definitions.invited!.sessions = {
          others: "invited",
          maxInvitedAccess: "send",
          invitedPermission: "read-only",
          invitedTools: ["read"],
        };
        fixture.setConfig(narrow);
        publishOperatorRoleConfigChange(fixture.context);
        expect(original.authority.signal?.aborted).toBe(false);
        const restricted = await restore();
        try {
          expect(restricted.authority.participationCeiling?.permission).toBe("read-only");
          expect(
            participationAllowsTool(
              expectDefined(restricted.authority.participationCeiling, "restricted invitation"),
              "exec",
            ),
          ).toBe(false);
          const retained = expectDefined(
            restricted.authority.recoverySnapshot,
            "durable restriction",
          );
          const wide = structuredClone(narrow);
          wide.gateway!.roles!.definitions.invited!.sessions = {
            others: "invited",
            maxInvitedAccess: "send",
            invitedPermission: "full",
            invitedTools: ["*"],
          };
          fixture.setConfig(wide);
          publishOperatorRoleConfigChange(fixture.context);
          const resumed = await restore(retained);
          try {
            expect(resumed.authority.participationCeiling?.permission).toBe("read-only");
            expect(
              participationAllowsTool(
                expectDefined(resumed.authority.participationCeiling, "resumed invitation"),
                "exec",
              ),
            ).toBe(false);
          } finally {
            resumed.release();
          }
        } finally {
          restricted.release();
        }
        await patchSessionEntryCore(target, () => ({ sessionRoot: "/different-invitation-root" }));
        await expect(restore()).rejects.toThrow("Session is unavailable for this principal.");
      } finally {
        original.release();
      }
    },
    {
      scopes: ["operator.sessions.read"],
      config: {
        gateway: {
          roles: {
            default: "invited",
            definitions: {
              invited: {
                agents: ["main"],
                scopes: ["operator.sessions.read"],
                sessions: {
                  others: "invited",
                  maxInvitedAccess: "send",
                  invitedTools: ["read", "exec"],
                },
              },
            },
          },
        },
      },
    },
  ));
