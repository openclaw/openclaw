import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

function sandboxRoleClient(role: "view" | "write"): GatewayClient {
  const profile = ensureProfileForEmail(`sandbox-required-${role}@example.test`);
  setUserProfileRole(profile.id, role);
  return {
    connect: gatewayConnect(["operator.read", "operator.write"]),
    authenticatedUserId: profile.id,
    authenticatedUserProfile: gatewayProfile(profile.id),
  };
}

describe("session sharing sandbox requirements", () => {
  it("denies sandbox-required members host execution without changing session provenance", () =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      cfg.gateway!.roles!.definitions.view!.sandbox = "required";
      setRuntimeConfigSnapshot(cfg);
      const guest = sandboxRoleClient("view");
      const maintainer = sandboxRoleClient("write");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      using authorizations = new DisposableStack();
      const guestId = guest.authenticatedUserProfile!.profileId;
      const maintainerId = maintainer.authenticatedUserProfile!.profileId;
      const hostSessionKey = "agent:main:maintainer-host-session";
      const sandboxSessionKey = "agent:main:guest-sandbox-session";

      for (const [sessionId, id, sandbox] of [
        ["maintainer-host-session", maintainerId, undefined],
        ["guest-sandbox-session", guestId, "required"],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:${sessionId}` },
          {
            sessionId,
            updatedAt: 1,
            visibility: "shared",
            ...(sandbox ? { sandbox } : {}),
            createdActor: { type: "human", source: "profile", id },
          },
        );
      }
      addSessionMember(
        { agentId: "main", sessionKey: hostSessionKey },
        {
          identityId: guestId,
          addedBy: maintainerId,
          expectedSessionId: "maintainer-host-session",
        },
      );

      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const authorize = async (
        client = guest,
        method = "chat.send",
        key = hostSessionKey,
        requestContext = context,
      ) => {
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          method,
          context: requestContext,
          requestParams: method.startsWith("sessions.") ? { key } : { sessionKey: key },
        });
        authorizations.defer(() => result.authorization?.release?.());
        return result;
      };
      for (const method of [
        "agent",
        "chat.send",
        "message.action",
        "send",
        "sessions.dispatch",
        "sessions.send",
        "sessions.steer",
        "talk.client.create",
        "talk.client.toolCall",
        "talk.session.create",
        "tools.invoke",
        "wake",
      ]) {
        expect((await authorize(guest, method)).error, method).toMatchObject({
          code: "FORBIDDEN",
          message: expect.stringMatching(/sandbox/i),
        });
      }
      expect((await authorize(guest, "sessions.patch")).error).toBeNull();

      for (const participant of [guest, maintainer]) {
        expect((await authorize(participant, "chat.send", sandboxSessionKey)).error).toBeNull();
      }

      cfg.gateway!.roles!.definitions.view!.sandbox = "inherit";
      const admittedHostRun = await authorize();
      expect(admittedHostRun.error).toBeNull();
      expect(admittedHostRun.authorization).toBeDefined();
      cfg.gateway!.roles!.definitions.view!.sandbox = "required";
      expect(() => admittedHostRun.authorization!.assertCurrent()).toThrow(
        SessionMutationAuthorizationChangedError,
      );

      const unscoped = await authorize(guest, "chat.send", hostSessionKey, {
        getRuntimeConfig: () => ({}),
      } as GatewayRequestContext);
      expect(unscoped.error).toBeNull();
    }));
});
