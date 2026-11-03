import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { makeMockHttpResponse } from "./test-http-response.js";

// mock-isolation: Control authentication outcomes while testing request-authority handoff.
vi.mock("./auth.js", () => ({ authorizeHttpGatewayConnect: vi.fn() }));

const defaultConfig = vi.hoisted(() => ({
  gateway: { controlUi: { allowedOrigins: ["https://control.example.com"] } },
}));

// mock-isolation: Supply a fixed auth-policy snapshot without reading operator config.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: vi.fn(() => defaultConfig) }));
// mock-isolation: Keep config I/O isolated from request-auth fixtures.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => defaultConfig) }));

// Export every binding http-auth-utils.js imports from http-common.js so this
// factory stays safe under isolate:false regardless of which paths execute.
vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
  sendJson: vi.fn(),
  sendMissingScopeForbidden: vi.fn(),
  sendUnauthorized: vi.fn(),
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { getRuntimeConfig } = await import("../config/io.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const profileWrites = await import("../state/user-profile-writes.js");
const profileAuthority = await import("../state/user-channel-identity-operations.js");
const operatorRoles = await import("./operator-role-policy.js");
const githubIdentity = await import("./github-user-identity.js");
const { resolveControlUiPluginAuthCookieGeneration } = await import("./http-auth-plugin-cookie.js");
const { authorizeGatewayHttpRequestOrReply } = await import("./http-utils.js");

const ownerProfile = {
  profileId: "profile-owner",
  displayName: "Owner",
  avatarRevision: "2",
  hasAvatar: false,
  updatedAt: 2,
};
const expectedGuestProfile = { ...ownerProfile, profileId: "profile-guest", displayName: "Guest" };
const expectedGitHubProfile = {
  profileId: "profile-github-canonical",
  displayName: "GitHub User",
  avatarRevision: "3",
  hasAvatar: true,
  updatedAt: 3,
};

const readProfileSource = () => ({
  path: "/synthetic/openclaw.sqlite",
  env: { OPENCLAW_STATE_DIR: "/synthetic" },
});
function profileAuthorityFixture(
  { profileId, displayName, avatarRevision, hasAvatar }: typeof ownerProfile,
  aliases = [profileId],
) {
  return {
    profileId,
    role: null,
    aliases,
    isCurrent: () => true,
    readSource: readProfileSource,
    display: { id: profileId, displayName, avatarRevision, hasAvatar },
  };
}

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

const trustedProxyAuth = {
  mode: "trusted-proxy",
  allowTailscale: false,
  trustedProxy: { userHeader: "x-user" },
} as const;
const tokenAuth = { mode: "token", allowTailscale: false, token: "shared-secret" } as const;
const authorityMethods = {
  hasCurrentClientAuthority: expect.any(Function),
  assertCurrent: expect.any(Function),
  revalidate: expect.any(Function),
};
const guestAuth = { ok: true, method: "trusted-proxy", user: "guest@example.test" } as const;
const mockAuth = (result: Awaited<ReturnType<typeof authorizeHttpGatewayConnect>> = guestAuth) =>
  vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue(result);
const expectedGuestAuth = {
  ...authorityMethods,
  authMethod: "trusted-proxy",
  user: guestAuth.user,
  trustDeclaredOperatorScopes: true,
};
function expectedProfileAuth(profile: typeof ownerProfile, aliases = [profile.profileId]) {
  return {
    ...expectedGuestAuth,
    hasCurrentProfileAuthority: expect.any(Function),
    operatorAccessAuthority: null,
    authenticatedUserProfile: profile,
    preparedSessionProfile: {
      profileId: profile.profileId,
      aliases: new Set(aliases),
      role: null,
      githubLogin: undefined,
    },
  };
}
const guestProfile = {
  id: "profile-guest",
  displayName: "Guest",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
};
const guestRole = (others: "view" | "none") => ({
  sessions: { others },
  agents: ["guest"],
  scopes: ["operator.read" as const],
});
const withGuestRole = (others: "view" | "none") => ({
  gateway: { roles: { default: "guest", definitions: { guest: guestRole(others) } } },
});
const authorize = (
  params: Partial<Parameters<typeof authorizeGatewayHttpRequestOrReply>[0]> = {},
) =>
  authorizeGatewayHttpRequestOrReply({
    req: createReq(),
    res: {} as ServerResponse,
    auth: trustedProxyAuth,
    ...params,
  });

describe("authorizeGatewayHttpRequestOrReply", () => {
  beforeEach(() => {
    vi.mocked(authorizeHttpGatewayConnect).mockReset();
    vi.mocked(sendGatewayAuthFailure).mockReset();
    vi.spyOn(profileWrites, "ensureCanonicalUserProfileForEmail").mockResolvedValue(guestProfile);
    vi.spyOn(profileWrites, "ensureCanonicalGatewayOwnerProfile").mockResolvedValue({
      id: ownerProfile.profileId,
      displayName: ownerProfile.displayName,
      avatarMime: null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: ownerProfile.updatedAt,
    });
    vi.spyOn(profileAuthority, "prepareUserProfileRoleAuthority").mockImplementation(
      async (profileId) =>
        profileAuthorityFixture({
          ...ownerProfile,
          profileId,
          displayName: profileId === ownerProfile.profileId ? ownerProfile.displayName : "Guest",
        }),
    );
    vi.spyOn(githubIdentity, "createAuthenticatedGitHubIdentitySync").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getRuntimeConfig).mockReturnValue(defaultConfig);
  });

  it.each(["password"] as const)(
    "marks %s-authenticated requests as untrusted for declared HTTP scopes",
    async (method) => {
      vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
        ok: true,
        method,
      });

      await expect(
        authorizeGatewayHttpRequestOrReply({
          req: createReq({ authorization: "Bearer secret" }),
          res: {} as ServerResponse,
          auth: { mode: "trusted-proxy", allowTailscale: false, token: "secret" },
          trustedProxies: ["127.0.0.1"],
        }),
      ).resolves.toEqual({
        hasCurrentClientAuthority: expect.any(Function),
        assertCurrent: expect.any(Function),
        revalidate: expect.any(Function),
        authMethod: method,
        trustDeclaredOperatorScopes: false,
        authenticatedUserProfile: ownerProfile,
        operatorRoleActor: { kind: "system" },
      });
    },
  );

  it.each([{ trustedProxies: undefined }, { trustedProxies: ["192.0.2.1"] }])(
    "keeps trusted-proxy overrides current with runtime proxies $trustedProxies",
    async ({ trustedProxies }) => {
      mockAuth({ ok: true, method: "trusted-proxy", user: "operator" });
      const originalConfig = getRuntimeConfig();
      let currentConfig = {
        ...originalConfig,
        gateway: { ...originalConfig.gateway, trustedProxies },
      };
      const { res } = makeMockHttpResponse();
      vi.mocked(getRuntimeConfig).mockImplementation(() => currentConfig);
      try {
        const admitted = await authorize({
          req: createReq({ authorization: "Bearer upstream-idp-token" }),
          res,
          trustedProxies: ["127.0.0.1"],
        });
        expect(admitted).toMatchObject({
          authMethod: "trusted-proxy",
          user: "operator",
          trustDeclaredOperatorScopes: true,
        });
        expect(admitted?.hasCurrentClientAuthority()).toBe(true);
        await expect(admitted?.revalidate()).resolves.toBeUndefined();
        currentConfig = {
          ...currentConfig,
          gateway: { ...currentConfig.gateway, trustedProxies: ["198.51.100.1"] },
        };
        expect(admitted?.hasCurrentClientAuthority()).toBe(false);
        await expect(admitted?.revalidate()).rejects.toThrow("Unauthorized");
      } finally {
        res.destroy();
      }
    },
  );

  const outcomes = [
    "completed",
    "disconnected",
    "policy-changed",
    "stale-at-entry",
    "identity-grants",
  ] as const;
  it.each(
    (["global", "gateway"] as const).flatMap((configSource) =>
      outcomes.map((outcome) => ({ configSource, outcome })),
    ),
  )(
    "keeps HTTP authorization pending on profile acquisition and revalidates before completion ($configSource policy, $outcome)",
    async ({ configSource, outcome }) => {
      const started = createDeferred();
      const release = createDeferred();
      const response = { destroyed: false };
      const originalConfig = getRuntimeConfig();
      let currentConfig =
        configSource === "gateway"
          ? {
              ...originalConfig,
              gateway: { ...originalConfig.gateway, trustedProxies: ["127.0.0.1"] },
            }
          : originalConfig;
      const setCurrentConfig = (config: ReturnType<typeof getRuntimeConfig>) => {
        currentConfig = config;
        if (configSource === "global") {
          vi.mocked(getRuntimeConfig).mockReturnValue(config);
        }
      };
      const updateGateway = (gateway: ReturnType<typeof getRuntimeConfig>["gateway"]) =>
        setCurrentConfig({ ...currentConfig, gateway: { ...currentConfig.gateway, ...gateway } });
      const changeOrigins = () =>
        updateGateway({
          controlUi: { allowedOrigins: ["https://changed.example.test"] },
        });
      const changeIdentityScopes = (email: string) =>
        updateGateway({
          auth: { ...currentConfig.gateway?.auth, identityScopes: { [email]: ["operator.admin"] } },
        });
      vi.mocked(authorizeHttpGatewayConnect).mockImplementationOnce(async () => {
        if (outcome === "stale-at-entry") {
          changeOrigins();
        }
        return guestAuth;
      });
      vi.mocked(profileWrites.ensureCanonicalUserProfileForEmail).mockImplementationOnce(
        async (_email, options) => {
          started.resolve();
          await release.promise;
          options?.assertCurrent?.();
          return guestProfile;
        },
      );
      let completed = false;
      const pending = authorize({
        ...(configSource === "gateway"
          ? { cfg: currentConfig, getRuntimeConfig: () => currentConfig }
          : {}),
        res: response as ServerResponse,
      }).then((result) => {
        completed = true;
        return result;
      });
      try {
        if (outcome === "stale-at-entry") {
          expect(await pending).toBeNull();
          expect(profileWrites.ensureCanonicalUserProfileForEmail).not.toHaveBeenCalled();
          return;
        }
        await Promise.race([
          started.promise,
          pending.then(() => {
            throw new Error("HTTP authorization completed before profile acquisition");
          }),
        ]);
        expect(completed).toBe(false);
        expect(profileAuthority.prepareUserProfileRoleAuthority).not.toHaveBeenCalled();
        if (outcome === "disconnected") {
          response.destroyed = true;
        }
        if (outcome === "policy-changed") {
          changeOrigins();
        }
        const cookieGeneration = resolveControlUiPluginAuthCookieGeneration(
          "shared-auth",
          currentConfig,
        );
        if (outcome === "identity-grants") {
          changeIdentityScopes("other@example.test");
        }
        release.resolve();
        const result = await pending;
        if (outcome === "completed" || outcome === "identity-grants") {
          expect(result?.authenticatedUserProfile?.profileId).toBe("profile-guest");
          if (outcome === "identity-grants") {
            expect(resolveControlUiPluginAuthCookieGeneration("shared-auth", currentConfig)).toBe(
              cookieGeneration,
            );
            changeIdentityScopes("guest@example.test");
            expect(result?.hasCurrentClientAuthority()).toBe(true);
            await expect(result?.revalidate()).resolves.toBeUndefined();
          }
        } else {
          expect(result).toBeNull();
          expect(profileAuthority.prepareUserProfileRoleAuthority).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each([true, false])(
    "binds trusted-proxy requests to their canonical profile with roles enabled: %s",
    async (rolesConfigured) => {
      const role = guestRole("view");
      vi.mocked(getRuntimeConfig).mockReturnValue({
        gateway: rolesConfigured
          ? { roles: { default: "guest", definitions: { guest: role } } }
          : {},
      });
      const ensureProfile = vi.mocked(profileWrites.ensureCanonicalUserProfileForEmail);
      vi.spyOn(operatorRoles, "resolveOperatorRolePolicyForAssignment").mockReturnValue(
        rolesConfigured ? role : undefined,
      );
      mockAuth();

      await expect(
        authorize({ req: createReq({ authorization: "Bearer upstream-idp-token" }) }),
      ).resolves.toEqual({
        ...expectedProfileAuth(expectedGuestProfile),
        ...(rolesConfigured ? { operatorRolePolicy: role } : {}),
      });
      expect(ensureProfile).toHaveBeenCalledWith("guest@example.test", {
        assertCurrent: expect.any(Function),
      });
    },
  );

  it.each([
    { rolesConfigured: false, failure: "profile store" },
    { rolesConfigured: true, failure: "provider lookup" },
  ])(
    "$failure failure preserves authorization with roles enabled: $rolesConfigured",
    async ({ rolesConfigured, failure }) => {
      vi.mocked(getRuntimeConfig).mockReturnValue(
        rolesConfigured ? { gateway: { roles: { default: "guest", definitions: {} } } } : {},
      );
      const error = new Error("identity unavailable");
      if (failure === "provider lookup") {
        vi.mocked(githubIdentity.createAuthenticatedGitHubIdentitySync).mockReturnValue(
          vi.fn().mockRejectedValue(error),
        );
      } else {
        vi.mocked(profileWrites.ensureCanonicalUserProfileForEmail).mockImplementation(() => {
          throw error;
        });
      }
      mockAuth();
      const response = {} as ServerResponse;

      const result = await authorize({ res: response });
      if (rolesConfigured) {
        expect(result).toBeNull();
        expect(sendGatewayAuthFailure).toHaveBeenCalledWith(response, {
          ok: false,
          reason: "user_profile_unavailable",
        });
      } else {
        expect(result).toEqual(expectedGuestAuth);
        expect(sendGatewayAuthFailure).not.toHaveBeenCalled();
      }
    },
  );

  it("uses the verified GitHub profile before dispatching a request without roles", async () => {
    vi.mocked(githubIdentity.createAuthenticatedGitHubIdentitySync).mockReturnValue(
      vi.fn().mockResolvedValue({ profileId: "profile-github", updatedAt: 3 }),
    );
    vi.mocked(profileAuthority.prepareUserProfileRoleAuthority).mockResolvedValue(
      profileAuthorityFixture(expectedGitHubProfile, [
        "profile-github",
        "profile-github-canonical",
      ]),
    );
    mockAuth();

    await expect(authorize()).resolves.toEqual(
      expectedProfileAuth(expectedGitHubProfile, ["profile-github", "profile-github-canonical"]),
    );
    expect(profileWrites.ensureCanonicalUserProfileForEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["device-token", "view"],
    ["trusted-proxy", "none"],
    ["tailscale", "none"],
    ["bootstrap-token", "none"],
  ] as const)(
    "rejects identity-less %s authentication when operator roles require durable identity",
    async (method, others) => {
      vi.mocked(getRuntimeConfig).mockReturnValue(withGuestRole(others));
      mockAuth({ ok: true, method });
      const response = {} as ServerResponse;

      await expect(authorize({ res: response, auth: tokenAuth })).resolves.toBeNull();
      expect(sendGatewayAuthFailure).toHaveBeenCalledWith(response, {
        ok: false,
        reason: "user_profile_unavailable",
      });
    },
  );

  it("preserves shared-secret owner authentication when operator roles are configured", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue(withGuestRole("none"));
    mockAuth({ ok: true, method: "token" });

    await expect(
      authorize({
        req: createReq({ authorization: "Bearer shared-secret" }),
        auth: tokenAuth,
      }),
    ).resolves.toEqual({
      ...authorityMethods,
      authMethod: "token",
      trustDeclaredOperatorScopes: false,
      authenticatedUserProfile: ownerProfile,
      operatorRoleActor: { kind: "system" },
    });
  });

  it("forwards browser-origin policy into HTTP auth", async () => {
    mockAuth({ ok: true, method: "trusted-proxy", user: "operator" });

    await authorize({
      req: createReq({
        host: "gateway.example.com",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      }),
      trustedProxies: ["127.0.0.1"],
    });

    expect(
      vi.mocked(authorizeHttpGatewayConnect).mock.calls.at(-1)?.[0].browserOriginPolicy,
    ).toEqual({
      requestHost: "gateway.example.com",
      origin: "https://evil.example",
      fetchSite: "cross-site",
      allowedOrigins: ["https://control.example.com"],
      allowHostHeaderOriginFallback: false,
    });
  });

  it("replies with auth failure and returns null when auth fails", async () => {
    const res = {} as ServerResponse;
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: false,
      reason: "unauthorized",
    });

    await expect(
      authorize({ res, auth: { mode: "token", allowTailscale: false, token: "secret" } }),
    ).resolves.toBeNull();

    expect(sendGatewayAuthFailure).toHaveBeenCalledWith(res, {
      ok: false,
      reason: "unauthorized",
    });
  });
});
