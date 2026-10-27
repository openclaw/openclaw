import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { seedRow } from "../session-row-projection.read-fixture.test-support.js";
import * as sharingRead from "../session-sharing-read.js";
import { rolePolicyConfig, sharingPolicyClient } from "../session-sharing.test-utils.js";
import { listSessions, requestContext } from "./sessions-read-cache.test-support.js";
import { callSessionSharingHandler } from "./sessions-sharing.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("rechecks invited membership in retained sessions.list after child and parent removal", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    setRuntimeConfigSnapshot(cfg);
    const owner = ensureProfileForEmail("owner@handler-revocation.test");
    const member = ensureProfileForEmail("member@handler-revocation.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const clients = [owner, member].map((profile) => {
      const client = sharingPolicyClient({ user: profile.id });
      prepareGatewayRecipientProfile(client);
      return client;
    });
    const original = sharingRead.prepareProjectedSessionSharing;
    // Configuration activation is step 13; the handlers, membership writes,
    // projection publications, and serialized inventory path are production owners.
    vi.spyOn(sharingRead, "prepareProjectedSessionSharing").mockImplementation((params) => ({
      ...original(params),
      ...sharingRead.prepareSessionSharing(params, {
        aliases: new Set([params.client?.authenticatedUserProfile?.profileId ?? ""]),
        sessionCap: "invited",
        isMember: params.isMember,
      }),
    }));
    const parent = "agent:main:dashboard:handler-parent";
    const child = "agent:main:subagent:handler-child";
    for (const key of [parent, child]) {
      seedRow(key, {
        sessionId: key,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
        ...(key === child ? { parentSessionKey: parent } : {}),
      });
      addSessionMember(
        { agentId: "main", sessionKey: key },
        { identityId: member.id, addedBy: owner.id },
      );
    }
    const context = { ...requestContext(cfg), broadcast: vi.fn(), broadcastToConnIds: vi.fn() };
    const list = () =>
      listSessions({
        context,
        client: clients[1]!,
        request: { agentId: "main", limit: 50 },
        acceptsSerializedJson: true,
      });
    const keys = (result: Awaited<ReturnType<typeof list>>) =>
      result.sessions.map((row) => row.key).toSorted();
    expect(keys(await list())).toEqual([child, parent].toSorted());
    const remove = async (sessionKey: string) => {
      const response = await callSessionSharingHandler(
        "session.members.remove",
        { sessionKey, identityId: member.id },
        context,
        clients[0]!,
      );
      expect(response).toHaveLength(1);
      expect(response[0]?.[0]).toBe(true);
    };
    await remove(child);
    const afterChild = await list();
    await remove(parent);
    const afterParent = await list();
    expect([keys(afterChild), keys(afterParent)]).toEqual([[parent], []]);
    expect(afterChild.sessions[0]?.childSessions).toBeUndefined();
  });
});
