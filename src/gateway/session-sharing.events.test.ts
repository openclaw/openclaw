import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createBroadcastPeer } from "./server-broadcast.test-support.js";
import {
  initializeSessionReadContext,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  canReceiveSessionEvent,
  prepareProjectedSessionSharing,
  prepareSessionSharing,
} from "./session-sharing.js";
import { sharingPolicyClient as client } from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it("filters event recipients by draft ownership, suggestion participation, and row existence", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const context = requestContext(cfg);
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    for (const [visibility, recipients] of [
      [
        "suggest",
        [
          [client({ user: "author" }), "session.suggestion", true],
          [client({ user: "member" }), "session.suggestion", true],
          [client({ user: "owner" }), "session.suggestion", true],
          [client({ user: "viewer" }), "session.suggestion", false],
          [client({}), "session.suggestion", false],
        ],
      ],
      [
        "draft",
        [
          [client({ user: "owner" }), "session.typing", true],
          [client({ user: "member" }), "session.typing", false],
          [client({ user: "viewer" }), "session.typing", false],
          [client({ user: "member" }), "session.message", false],
          [client({ user: "admin", scopes: ["operator.admin"] }), "session.typing", true],
          [client({}), "session.typing", false],
        ],
      ],
      [undefined, [[client({ user: "viewer@example.com" }), undefined, false]]],
    ] as const) {
      const sessionKey = `agent:main:events-${visibility ?? "deleted"}`;
      const sessionId = `session-${visibility}`;
      const scope = { agentId: "main", sessionKey };
      if (visibility) {
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility,
        });
        addSessionMember(scope, {
          identityId: "member",
          addedBy: "owner",
          expectedSessionId: sessionId,
        });
      }
      await projection.ensureMaterialized();
      await projection.prepareMembership();
      const check = (recipient: GatewayClient, event?: string, sessionKeys = [sessionKey]) =>
        canReceiveSessionEvent({
          cfg,
          client: recipient,
          sessionKeys,
          event,
          prepared: {
            sharing: prepareProjectedSessionSharing({
              cfg,
              client: recipient,
              isMember: (selected, id) =>
                projection.hasMembership(selected.storePath, selected.storeKey, id),
            }),
            target: (key) => projection.sharingTarget({ key, agentId: "main" }),
          },
          ...(event === "session.suggestion"
            ? { payload: { suggestion: { author: { id: "author" } } } }
            : {}),
        });
      for (const [recipient, event, visible] of recipients) {
        expect(check(recipient, event), `${visibility}: ${event}`).toBe(visible);
      }
      if (visibility === "suggest") {
        const recipient = client({ user: "author", displayName: "Viewer" });
        recipient.internal = { operatorRoleActor: { kind: "operator", profileId: "viewer" } };
        expect(check(recipient, "session.suggestion")).toBe(true);
        recipient.authenticatedUserProfile!.profileId = "viewer";
        expect(check(recipient, "session.suggestion")).toBe(false);
        recipient.internal.operatorRoleActor = { kind: "operator", profileId: "author" };
        expect(check(recipient, "session.suggestion")).toBe(false);
        recipient.authenticatedUserProfile = undefined;
        expect(check(recipient, "session.suggestion")).toBe(true);

        removeSessionMember(scope, "member", undefined, sessionId);
        expect(check(client({ user: "member" }), "session.suggestion")).toBe(false);
      } else {
        for (const keys of [
          ["agent:main:events-suggest", sessionKey],
          [sessionKey, "agent:main:events-suggest"],
        ]) {
          expect(check(client({ user: "author" }), "session.suggestion", keys)).toBe(false);
        }
      }
    }
  });
});

it("checks prepared invited membership at final Gateway event delivery after revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const context = requestContext(cfg);
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    const sessionKey = "agent:main:invited-event";
    const sessionId = "invited-event-session";
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: "owner" },
      visibility: "shared",
    });
    addSessionMember(scope, {
      identityId: "member",
      addedBy: "owner",
      expectedSessionId: sessionId,
    });
    await projection.ensureMaterialized();
    await projection.prepareMembership();
    const peers = ["owner", "member", "unrelated"].map((profileId) => {
      const peer = createBroadcastPeer(profileId, true);
      Object.assign(peer.client, client({ user: profileId }));
      return peer;
    });
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map((peer) => peer.client)),
      canReceiveSessionEvent: (recipient, sessionKeys, agentId, event, payload) => {
        const profileId = recipient.authenticatedUserProfile!.profileId;
        return canReceiveSessionEvent({
          cfg,
          client: recipient,
          sessionKeys,
          agentId,
          event,
          payload,
          prepared: {
            // Step 1 prepares this policy; configuration activation belongs to step 13.
            // Membership and the delivery decision still use their production owners.
            sharing: prepareSessionSharing(
              { cfg, client: recipient },
              {
                aliases: new Set([profileId]),
                sessionCap: "invited",
                isMember: (target, id) =>
                  projection.hasMembership(target.storePath, target.storeKey, id),
              },
            ),
            target: (key) => projection.sharingTarget({ key, agentId: "main" }),
          },
        });
      },
    });
    const publish = (text: string) =>
      broadcast("session.message", { sessionKey, text }, { sessionKeys: [sessionKey] });
    publish("permitted");
    expect(peers.map((peer) => peer.frames.map((frame) => frame.payload))).toEqual([
      [{ sessionKey, text: "permitted" }],
      [{ sessionKey, text: "permitted" }],
      [],
    ]);
    removeSessionMember(scope, "member", undefined, sessionId);
    await Promise.resolve();
    publish("after revocation");
    expect(peers.map((peer) => peer.frames.map((frame) => frame.payload))).toEqual([
      [
        { sessionKey, text: "permitted" },
        { sessionKey, text: "after revocation" },
      ],
      [{ sessionKey, text: "permitted" }],
      [],
    ]);
  });
});
