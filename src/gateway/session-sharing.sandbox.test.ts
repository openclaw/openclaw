import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import {
  authorizeResolvedSessionMutationAsync,
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

function sandboxRoleClient(role: "view" | "write"): GatewayClient {
  const profile = ensureProfileForEmail(`sandbox-required-${role}@example.test`);
  setUserProfileRole(profile.id, role);
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserId: profile.id,
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

describe("session sharing sandbox requirements", () => {
  it("denies sandbox-required members host execution without changing session provenance", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "view",
            definitions: {
              view: {
                sessions: { others: "view" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
                sandbox: "required",
              },
              write: {
                sessions: { others: "write" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const guest = sandboxRoleClient("view");
      const maintainer = sandboxRoleClient("write");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      using authorizations = new DisposableStack();
      const guestId = guest.authenticatedUserProfile!.profileId;
      const maintainerId = maintainer.authenticatedUserProfile!.profileId;
      const hostSessionKey = "agent:main:maintainer-host-session";
      const sandboxSessionKey = "agent:main:guest-sandbox-session";

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: hostSessionKey },
        {
          sessionId: "maintainer-host-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: maintainerId },
        },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: sandboxSessionKey },
        {
          sessionId: "guest-sandbox-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: guestId },
          sandbox: "required",
        },
      );
      addSessionMember(
        { agentId: "main", sessionKey: hostSessionKey },
        {
          identityId: guestId,
          addedBy: maintainerId,
          expectedSessionId: "maintainer-host-session",
        },
      );

      const hostTarget = resolveSessionSharingTarget({ cfg, sessionKey: hostSessionKey });
      expect(hostTarget).not.toBeNull();
      if (!hostTarget) {
        throw new Error("expected persisted maintainer session");
      }
      expect(
        await authorizeResolvedSessionMutationAsync({
          cfg,
          client: guest,
          sessionKey: hostSessionKey,
          agentId: "main",
        }),
      ).toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/sandbox/i) });

      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
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
        const requestParams = method.startsWith("sessions.")
          ? { key: hostSessionKey }
          : { sessionKey: hostSessionKey };
        expect(
          (
            await resolveSessionMutationAuthorizationAsync({
              client: guest,
              method,
              requestParams,
              context,
            })
          ).error,
          method,
        ).toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/sandbox/i) });
      }
      const patch = await resolveSessionMutationAuthorizationAsync({
        client: guest,
        method: "sessions.patch",
        requestParams: { key: hostSessionKey },
        context,
      });
      authorizations.defer(() => patch.authorization?.release?.());
      expect(patch.error).toBeNull();

      for (const participant of [guest, maintainer]) {
        const sandboxRun = await resolveSessionMutationAuthorizationAsync({
          client: participant,
          method: "chat.send",
          requestParams: { sessionKey: sandboxSessionKey },
          context,
        });
        authorizations.defer(() => sandboxRun.authorization?.release?.());
        expect(sandboxRun.error).toBeNull();
      }

      cfg.gateway!.roles!.definitions.view!.sandbox = "inherit";
      const admittedHostRun = await resolveSessionMutationAuthorizationAsync({
        client: guest,
        method: "chat.send",
        requestParams: { sessionKey: hostSessionKey },
        context,
      });
      authorizations.defer(() => admittedHostRun.authorization?.release?.());
      expect(admittedHostRun.error).toBeNull();
      expect(admittedHostRun.authorization).toBeDefined();
      cfg.gateway!.roles!.definitions.view!.sandbox = "required";
      expect(() => admittedHostRun.authorization!.assertCurrent()).toThrow(
        SessionMutationAuthorizationChangedError,
      );

      const unscoped = await resolveSessionMutationAuthorizationAsync({
        client: guest,
        method: "chat.send",
        requestParams: { sessionKey: hostSessionKey },
        context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
      });
      authorizations.defer(() => unscoped.authorization?.release?.());
      expect(unscoped.error).toBeNull();
    });
  });
});
