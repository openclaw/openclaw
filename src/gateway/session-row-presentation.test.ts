import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { readUserProfileIdentity, retainUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createExpectedProfileBinding,
  ExpectedProfileMismatchError,
  prepareGatewayRecipientProfile,
} from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("presents current recipient roles without SQLite while rejecting source overrides and excluded children", async () => {
  using _ = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("owner@presentation.test");
    const member = ensureProfileForEmail("member@presentation.test");
    const viewer = ensureProfileForEmail("viewer@presentation.test");
    setUserProfileRole(viewer.id, "none");
    const clients = [owner, member, viewer].map((profile) => {
      const client = Object.assign(sharingPolicyClient({ user: profile.id }), {
        connId: profile.id,
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: vi.fn(),
          close: vi.fn(),
        } as unknown as GatewayWsClient["socket"],
      }) as GatewayWsClient;
      prepareGatewayRecipientProfile(client);
      return client;
    });
    const cfg = rolePolicyConfig();
    const query = { agentId: "main", key: "agent:main:parent" };
    const scope = { agentId: "main", sessionKey: query.key };
    const entry = {
      sessionId: "parent-session",
      updatedAt: Date.now(),
      visibility: "suggest" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
    };
    replaceSessionEntrySync(scope, entry);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:child" },
      {
        sessionId: "child-session",
        updatedAt: Date.now(),
        parentSessionKey: query.key,
      },
    );
    addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
    const projection = await createSessionRowProjection({ cfg });
    const connection = createGatewayConnectionState({ bootId: "presentation", cfg });
    const detach = connection.attachSessionRowProjection(projection);
    for (const client of clients) {
      connection.clients.add(client);
    }
    try {
      const captured = projection.describe(query)!;
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      expect(
        prepareProjectedSessionPresentation(projection).present(captured)?.sharingRole,
      ).toBeUndefined();
      for (const [index, expectedRole, visible] of [
        [0, "owner", true],
        [1, "member", true],
        [2, "viewer", false],
      ] as const) {
        const client = clients[index]!;
        const presentation = prepareProjectedSessionPresentation(projection, client);
        expect(
          presentation.present(captured, { excludedChildKeys: new Set(["agent:main:child"]) }),
        ).toMatchObject({ sharingRole: expectedRole });
        expect(
          presentation.present(captured, { excludedChildKeys: new Set(["agent:main:child"]) })
            ?.childSessions,
        ).toBeUndefined();
        expect(
          canReceiveSessionEvent({
            cfg,
            client,
            sessionKeys: [query.key],
            agentId: "main",
            prepared: {
              sharing: presentation.sharing,
              target: (key) => presentation.target({ ...query, key }),
            },
          }),
        ).toBe(visible);
        expect(presentation.authorizeDescription(query)).toBeNull();
        connection.broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey: query.key,
            agentId: query.agentId,
            session: {
              key: query.key,
              sessionId: entry.sessionId,
              label: null,
              endedAt: null,
              status: "completed",
              activitySummary: { state: "stale", text: "Retained event summary" },
            },
          },
          new Set([client.connId]),
        );
        const socket = vi.mocked(client.socket);
        if (visible) {
          expect(socket.send.mock.calls).toHaveLength(1);
          const frame = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
          const expectedWire = JSON.stringify(
            prepareProjectedSessionPresentation(projection, client, Date.now(), connection).present(
              captured,
              {
                includeDerivedTitles: true,
                includeLastMessage: true,
              },
            ),
          );
          expect(frame.payload.session).toEqual(JSON.parse(expectedWire));
          expect(frame.payload.session).not.toMatchObject({ status: "completed", label: null });
        } else {
          expect(socket.send.mock.calls).toHaveLength(0);
        }
      }
      expect(
        prepareProjectedSessionPresentation(projection, clients[0]!).authorizeDescription({
          agentId: "main",
          key: "agent:main:dashboard:incognito-private",
        }),
      ).toMatchObject({ code: "INVALID_REQUEST" });
      expect(prepares).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      prepares.mockRestore();
      exec.mockRestore();
      removeSessionMember(scope, member.id);
      await projection.ensureMaterialized();
      expect(
        prepareProjectedSessionPresentation(projection, clients[1]!).snapshot(query).row
          ?.sharingRole,
      ).toBe("viewer");
      replaceSessionEntrySync(scope, { ...entry, sessionId: "replacement-session" });
      await projection.ensureMaterialized();
      expect(
        prepareProjectedSessionPresentation(projection, clients[0]!).present(captured),
      ).toBeNull();
      const socket = vi.mocked(clients[0]!.socket);
      socket.send.mockClear();
      for (const payload of [
        { sessionId: entry.sessionId, session: { sessionId: "replacement-session" } },
        { session: { sessionId: entry.sessionId } },
        { session: { sessionId: "replacement-session", lifecycleRevision: "retired" } },
      ]) {
        connection.broadcastToConnIds(
          "sessions.changed",
          { sessionKey: query.key, agentId: query.agentId, ...payload },
          new Set([clients[0]!.connId]),
        );
      }
      expect(socket.send.mock.calls).toHaveLength(0);
    } finally {
      detach();
      connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});

it("checks selected profile identity from current resident facts without following the requested ID through a merge", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const source = ensureProfileForEmail("source@expected-profile.test");
    const target = ensureProfileForEmail("target@expected-profile.test");
    const client = sharingPolicyClient({ user: source.id }) as GatewayWsClient;
    prepareGatewayRecipientProfile(client);
    const release = retainUserProfileCatalog();
    try {
      const binding = createExpectedProfileBinding(source.id, client)!;
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      binding.assertCurrent();
      const response = vi.fn();
      binding.guardResponse(response)(true, { session: null });
      expect(response).toHaveBeenCalledWith(true, { session: null });
      expect(prepares).not.toHaveBeenCalled();
      prepares.mockRestore();
      linkEmail("source@expected-profile.test", target.id);
      prepareGatewayRecipientProfile(client);
      const afterMerge = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(() => binding.assertCurrent()).toThrow(ExpectedProfileMismatchError);
      expect(readUserProfileIdentity(source.id)?.profileId).toBe(target.id);
      expect(afterMerge).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
