import { expect, it } from "vitest";
import {
  addSessionMember,
  setSessionMemberAccess,
} from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
    expect(before.map((row) => row?.sharingRole)).toEqual(["owner", "member", "member"]);
    await setSessionMemberAccess(scope, {
      identityId: sender.id,
      access: "suggest",
      expectedSessionId: "invited-row",
    });
    expect((await read()).map((row) => row?.invitedAccess)).toEqual([undefined, "read", "suggest"]);
    expect(before[2]?.invitedAccess).toBe("send");
  }));
