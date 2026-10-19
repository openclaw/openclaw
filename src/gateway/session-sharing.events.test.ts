import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  initializeSessionReadContext,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { canReceiveSessionEvent, prepareProjectedSessionSharing } from "./session-sharing.js";
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
