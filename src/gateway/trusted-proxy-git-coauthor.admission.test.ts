import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY,
  gitCoauthorOrganizationPolicy,
} from "../../packages/gateway-protocol/src/schema/git-coauthor-identity.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../state/user-preferences.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { resolveGatewayConnectProfileAdmission } from "./server/ws-connection/connect-user-profile.js";
import { syncTrustedProxyGitCoauthor } from "./trusted-proxy-git-coauthor.js";

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
const policy = gitCoauthorOrganizationPolicy("x-auth-user", {
  nameHeader: "x-credit-name",
  emailHeader: "x-credit-email",
});
const authResult = { ok: true, method: "trusted-proxy" as const, user: "oidc:issuer:alice" };

describe("organization credit through authenticated profile admission", () => {
  it.each(["http", "websocket"] as const)(
    "admits %s sign-in with 128 saved user preferences while synchronizing organization credit",
    async (transport) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot(cfg);
        const profile = await ensureCanonicalUserProfileForEmail(authResult.user);
        const saved = {
          ...Object.fromEntries(
            Array.from({ length: 127 }, (_, index) => [`saved-${index}`, index]),
          ),
          "git.coauthor.enabled": false,
        };
        for (let start = 0; start < 128; start += 32) {
          expect(
            await setCanonicalUserPreferences(
              profile.id,
              Object.fromEntries(Object.entries(saved).slice(start, start + 32)),
            ),
          ).toMatchObject({ ok: true });
        }
        const req = new IncomingMessage(new Socket());
        req.headers = { "x-credit-name": "Alice Example", "x-credit-email": "alice@example.test" };
        const admit = async (nextTransport: typeof transport = transport) => {
          if (nextTransport === "http") {
            const admitted = await resolveAuthenticatedHttpUserProfile({ req, authResult, cfg });
            return admitted.authenticatedUserProfile?.profileId;
          }
          const admitted = await resolveGatewayConnectProfileAdmission({
            context: {
              configSnapshot: cfg,
              handler: {
                connId: "credit-full-preferences",
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
          return admitted.ok ? admitted.prepared?.profile.profileId : undefined;
        };
        const read = async () => (await getCanonicalUserPreferences(profile.id))!.entries;
        try {
          expect(await admit()).toBe(profile.id);
          expect(await read()).toEqual({
            ...saved,
            [GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY]: {
              name: "Alice Example",
              email: "alice@example.test",
              policy,
            },
          });
          expect(
            await setCanonicalUserPreferences(profile.id, { "saved-128": true }),
          ).toMatchObject({
            ok: false,
            error: { code: "profile-key-limit", limit: 128, currentCount: 128 },
          });
          expect(
            await setCanonicalUserPreferences(profile.id, { "git.coauthor.enabled": true }),
          ).toMatchObject({ ok: true });
          const consented = { ...saved, "git.coauthor.enabled": true };
          req.headers = {
            "x-credit-name": "Alice Updated",
            "x-credit-email": "updated@example.test",
          };
          expect(await admit(transport === "http" ? "websocket" : "http")).toBe(profile.id);
          expect(await read()).toEqual({
            ...consented,
            [GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY]: {
              name: "Alice Updated",
              email: "updated@example.test",
              policy,
            },
          });
          req.headers = {};
          expect(await admit()).toBe(profile.id);
          expect(await read()).toEqual(consented);
        } finally {
          req.destroy();
        }
      });
    },
  );

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
});

it("publishes profile invalidation for changed and cleared proxy details only", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const profile = await ensureCanonicalUserProfileForEmail(authResult.user);
    const changed = vi.fn();
    const stop = onUserProfilesChanged(changed);
    const params = {
      authConfig: cfg.gateway?.auth,
      authResult,
      profileId: profile.id,
      headers: { "x-credit-name": "Alice Example", "x-credit-email": "alice@example.test" },
    };
    try {
      await syncTrustedProxyGitCoauthor(params);
      expect(changed).toHaveBeenCalledTimes(1);
      await syncTrustedProxyGitCoauthor(params);
      expect(changed).toHaveBeenCalledTimes(1);
      await syncTrustedProxyGitCoauthor({ ...params, headers: {} });
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
});

it("imports admitted proxy credit, preserves unrelated sign-ins and clears invalid claims", async () => {
  const authConfig = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-occ-identity",
      gitCoauthor: {
        nameHeader: "x-credit-name",
        emailHeader: "x-credit-email",
        emailVerifiedHeader: "x-credit-email-verified",
      },
    },
  };
  const headers = {
    "x-credit-name": "Alice Example",
    "x-credit-email": "alice@example.test",
    "x-credit-email-verified": "true",
  };

  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = await ensureCanonicalUserProfileForEmail(authResult.user);
    const params = { authConfig, authResult, headers, profileId: profile.id };
    const read = async () =>
      (await getCanonicalUserPreferences(profile.id))?.entries[
        GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY
      ];
    const identity = {
      name: "Alice Example",
      email: "alice@example.test",
      policy: gitCoauthorOrganizationPolicy(
        authConfig.trustedProxy.userHeader,
        authConfig.trustedProxy.gitCoauthor,
      ),
    };
    await syncTrustedProxyGitCoauthor({
      ...params,
      headers: {
        ...headers,
        "x-credit-name": " Alice Example ",
        "x-credit-email": " ALICE@example.test ",
      },
    });
    expect(await read()).toEqual(identity);
    await syncTrustedProxyGitCoauthor({ ...params, authResult: { ok: true, method: "token" } });
    expect(await read()).toEqual(identity);
    await syncTrustedProxyGitCoauthor({ ...params, authConfig: undefined });
    expect(await read()).toEqual(identity);

    for (const claims of [
      { ...headers, "x-credit-name": "" },
      { ...headers, "x-credit-email": "" },
      { ...headers, "x-credit-name": "Alice\nCo-authored-by: Mallory" },
      { ...headers, "x-credit-name": "Alice\u2028Other" },
      { ...headers, "x-credit-name": "Alice\u2029Other" },
      { ...headers, "x-credit-name": "Alice <Other>" },
      { ...headers, "x-credit-email": "alice@example.test\nOther" },
      { ...headers, "x-credit-email": "Alice <alice@example.test>" },
      { ...headers, "x-credit-email": "alice@example.test>" },
      { ...headers, "x-credit-email-verified": "false" },
      { ...headers, "x-credit-email-verified": undefined },
      { ...headers, "x-credit-email": ["alice@example.test", "mallory@example.test"] },
    ]) {
      await syncTrustedProxyGitCoauthor(params);
      expect(await read()).toEqual(identity);
      await syncTrustedProxyGitCoauthor({ ...params, headers: claims });
      expect(await read(), JSON.stringify(claims)).toBeUndefined();
    }

    const assertedMapping = { nameHeader: "x-credit-name", emailHeader: "x-credit-email" };
    await syncTrustedProxyGitCoauthor({
      ...params,
      authConfig: {
        ...authConfig,
        trustedProxy: { ...authConfig.trustedProxy, gitCoauthor: assertedMapping },
      },
      headers: { "x-credit-name": "Alice Example", "x-credit-email": "alice@example.test" },
    });
    expect(await read()).toEqual({
      ...identity,
      policy: gitCoauthorOrganizationPolicy(authConfig.trustedProxy.userHeader, assertedMapping),
    });
  });
});
