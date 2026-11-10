import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../state/user-preferences.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { resolveGatewayConnectProfileAdmission } from "./server/ws-connection/connect-user-profile.js";

const cfg: OpenClawConfig = {
  gateway: {
    roles: {
      default: "member",
      definitions: {
        member: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
      },
    },
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-auth-user",
        gitCoauthor: { nameHeader: "x-credit-name", emailHeader: "x-credit-email" },
      },
    },
  },
};
const authResult = { ok: true, method: "trusted-proxy" as const, user: "oidc:issuer:alice" };

describe("organization credit through authenticated profile admission", () => {
  it("imports defaults when a GitHub-backed profile would otherwise be deferred", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config: OpenClawConfig = { gateway: { auth: cfg.gateway?.auth } };
      setRuntimeConfigSnapshot(config);
      const profile = await ensureCanonicalUserProfileForEmail(authResult.user);
      const connected = await resolveGatewayConnectProfileAdmission({
        context: {
          configSnapshot: config,
          handler: {
            connId: "credit-deferred-admission",
            logWsControl: createSubsystemLogger("test/credit-admission"),
            close: vi.fn(),
          },
          markHandshakeFailure: vi.fn(),
          sendHandshakeErrorResponse: vi.fn(),
          releasePendingNodePairingCleanup: async () => {},
        },
        state: { authResult, authMethod: "trusted-proxy", role: "operator" },
        ownerProfileExpected: false,
        authenticatedUserId: authResult.user,
        requestHeaders: {
          "x-credit-name": "Alice Example",
          "x-credit-email": "alice@example.test",
        },
        resolveAuthenticatedGitHubIdentity: async () => ({
          profileId: profile.id,
          updatedAt: profile.updatedAt,
        }),
      });
      expect(connected.ok && connected.prepared?.profile.profileId).toBe(profile.id);
      expect((await getCanonicalUserPreferences(profile.id))?.entries).toMatchObject({
        [GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY]: {
          name: "Alice Example",
          email: "alice@example.test",
        },
      });
    });
  });
  it("refreshes and clears defaults across HTTP and WebSocket sign-ins without replacing an override", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      const req = new IncomingMessage(new Socket());
      req.headers = { "x-credit-name": "Alice Example", "x-credit-email": "alice@example.test" };
      try {
        const first = await resolveAuthenticatedHttpUserProfile({ req, authResult, cfg });
        const profileId = first.authenticatedUserProfile!.profileId;
        const read = async () => (await getCanonicalUserPreferences(profileId))!.entries;
        expect(await read()).toMatchObject({
          [GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY]: {
            name: "Alice Example",
            email: "alice@example.test",
          },
        });
        expect(
          await setCanonicalUserPreferences(profileId, {
            "git.coauthor.identity": { name: "Alice Custom", email: "custom@example.test" },
            "git.coauthor.enabled": true,
          }),
        ).toMatchObject({ ok: true });
        req.headers = { "x-credit-name": "Alice Updated", "x-credit-email": "new@example.test" };
        const connected = await resolveGatewayConnectProfileAdmission({
          context: {
            configSnapshot: cfg,
            handler: {
              connId: "credit-admission",
              logWsControl: createSubsystemLogger("test/credit-admission"),
              close: vi.fn(),
            },
            markHandshakeFailure: vi.fn(),
            sendHandshakeErrorResponse: vi.fn(),
            releasePendingNodePairingCleanup: async () => {},
          },
          state: { authResult, authMethod: "trusted-proxy", role: "operator" },
          ownerProfileExpected: false,
          authenticatedUserId: authResult.user,
          requestHeaders: req.headers,
          resolveAuthenticatedGitHubIdentity: undefined,
        });
        expect(connected.ok && connected.prepared?.profile.profileId).toBe(profileId);
        expect(await read()).toMatchObject({
          "git.coauthor.identity": { name: "Alice Custom", email: "custom@example.test" },
          [GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY]: {
            name: "Alice Updated",
            email: "new@example.test",
          },
        });
        req.headers = {};
        await resolveAuthenticatedHttpUserProfile({ req, authResult, cfg });
        expect(await read()).not.toHaveProperty(GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY);
        expect(await read()).toHaveProperty("git.coauthor.identity", {
          name: "Alice Custom",
          email: "custom@example.test",
        });
      } finally {
        req.destroy();
      }
    });
  });
});
