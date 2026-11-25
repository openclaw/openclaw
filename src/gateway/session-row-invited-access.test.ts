import { expect, it } from "vitest";
import {
  addSessionMember,
  readSessionMembersInWorker,
  setSessionMemberAccess,
} from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayOperatorRoleDefinitionSchema } from "../config/zod-schema.gateway-roles.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import {
  createTestProjection,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";

it("projects and invalidates recipient-local invited access without contaminating owner rows", () =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const owner = ensureProfileForEmail("owner@invited-row.test");
    const reader = ensureProfileForEmail("reader@invited-row.test");
    const sender = ensureProfileForEmail("sender@invited-row.test");
    for (const profile of [reader, sender]) {
      setUserProfileRole(profile.id, "guest");
    }
    const cfg: OpenClawConfig = {
      agents: { defaults: { utilityModel: "" } },
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              scopes: ["operator.sessions.read"],
              agents: "*",
              sandbox: "required",
              sessions: { others: "invited", maxInvitedAccess: "send" },
            },
          },
        },
      },
    };
    const query = { agentId: "main", key: "agent:main:invited-row" };
    const scope = { agentId: "main", sessionKey: query.key };
    seedRow(query, {
      sessionId: "invited-row",
      updatedAt: Date.now(),
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    for (const [profile, access] of [
      [reader, "read"],
      [sender, "send"],
    ] as const) {
      await addSessionMember(scope, {
        identityId: profile.id,
        addedBy: owner.id,
        addedAt: Date.now(),
        access,
      });
    }
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const clients = [owner, reader, sender].map((profile) => identifiedClient(profile.id));
    const read = async () => {
      await projection.ensureMaterialized();
      const publication = prepareSessionRowPublication(projection, Date.now());
      return clients.map((client) => publication(client).getPresentation().snapshot(query).row);
    };
    const before = await read();
    expect(before.map((row) => row?.invitedAccess)).toEqual([undefined, "read", "send"]);
    expect(before.map((row) => row?.invitedPermission)).toEqual([
      undefined,
      undefined,
      "workspace",
    ]);
    expect(before[1]?.workspaceReadDisabledReason).toBeNull();
    expect(before[2]?.sendDisabledReason).toBeNull();
    expect(before.map((row) => row?.sharingRole)).toEqual(["owner", "member", "member"]);
    await setSessionMemberAccess(scope, {
      identityId: sender.id,
      access: "suggest",
      expectedSessionId: "invited-row",
    });
    expect((await read()).map((row) => row?.invitedAccess)).toEqual([undefined, "read", "suggest"]);
    expect(before[2]?.invitedAccess).toBe("send");
  }));

// Released roles (2026.11.10 offers none/view/suggest/write) and main's ceiling-free
// "invited" decode unchanged, and unlevelled member rows keep main's sharing projection.
it("keeps stored roles and unlevelled member rows working as they did before invitations", () =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const others = ["none", "view", "suggest", "write", "invited"] as const;
    const definitions = Object.fromEntries(
      others.map((cap) => [
        cap,
        { scopes: ["operator.read", "operator.write"], agents: "*", sessions: { others: cap } },
      ]),
    );
    for (const definition of Object.values(definitions)) {
      expect(GatewayOperatorRoleDefinitionSchema.parse(definition)).toEqual(definition);
    }
    const cfg = {
      agents: { defaults: { utilityModel: "" } },
      gateway: { roles: { default: "none", definitions } },
    } as OpenClawConfig;
    const owner = ensureProfileForEmail("owner@stored-roles.test");
    const matrix: Record<string, unknown[]> = {};
    for (const visibility of ["shared", "suggest", "read-only"] as const) {
      const query = { agentId: "main", key: `agent:main:stored-${visibility}` };
      const scope = { agentId: "main", sessionKey: query.key };
      seedRow(query, {
        sessionId: `stored-${visibility}`,
        updatedAt: Date.now(),
        visibility,
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      const people = others.flatMap((cap) =>
        ["member", "other"].map((kind) => {
          const profile = ensureProfileForEmail(`${cap}-${kind}-${visibility}@roles.test`);
          setUserProfileRole(profile.id, cap);
          return { profile, member: kind === "member" };
        }),
      );
      for (const { profile } of people.filter(({ member }) => member)) {
        await addSessionMember(scope, { identityId: profile.id, addedBy: owner.id, addedAt: 1 });
      }
      const stored = await readSessionMembersInWorker(scope);
      expect(stored.members).toHaveLength(others.length);
      expect(stored.members.every((member) => member.access === undefined)).toBe(true);
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      const publication = prepareSessionRowPublication(projection, Date.now());
      matrix[visibility] = people.map(({ profile }) => {
        const row = publication(identifiedClient(profile.id)).getPresentation().snapshot(query).row;
        return row
          ? [
              row.sharingRole,
              row.sendDisabledReason === null,
              row.workspaceReadDisabledReason === null,
              row.invitedAccess ?? null,
            ]
          : null;
      });
    }
    const viewer = ["viewer", false, true, null];
    const sender = ["member", true, true, null];
    // [member, other] per role: none, view, suggest, write, ceiling-free invited.
    const expected = [
      viewer,
      viewer,
      sender,
      viewer,
      sender,
      viewer,
      sender,
      sender,
      sender,
      viewer,
    ];
    expect(matrix).toEqual({ shared: expected, suggest: expected, "read-only": expected });
  }));
