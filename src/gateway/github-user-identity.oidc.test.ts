import { DatabaseSync } from "node:sqlite";
import { describe, expect, it as baseIt, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.test-support.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { resolveUserProfileGitHubAttribution } from "../state/user-profile-github-identity.js";
import { getUserProfileListItem } from "../state/user-profile-list-item.test-support.js";
import {
  linkEmail,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import {
  accessOrigin,
  accessRequest,
  accountIdClaim,
  cfg,
  githubCfg,
  identityResponse,
  oidcIdentity,
} from "./github-user-identity.oidc.test-support.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { resolveGatewayConnectProfileAdmission } from "./server/ws-connection/connect-user-profile.js";

const accessIdentityUrl = `${accessOrigin}/cdn-cgi/access/get-identity`;
const emailIdentity = { email: "ada@example.test", idp: { type: "oidc" } };
const githubIdentity = { id: 101, login: "canonical-ada" };

function mockIdentityLookup(identity: unknown = oidcIdentity(), status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) =>
      url === accessIdentityUrl
        ? identityResponse(identity)
        : identityResponse(status === 200 ? githubIdentity : {}, status),
    );
}

function mockEmailIdentity() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => identityResponse(emailIdentity));
}

function expectCreditDisabled(profileId: string) {
  expect(getUserPreferences(profileId, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({
    [GIT_COAUTHOR_PREFERENCE_KEY]: false,
  });
}

async function expectNoAttribution(profileId: string) {
  expect((await resolveUserProfileGitHubAttribution([profileId])).get(profileId)).toBeNull();
}

function disposableAccessRequest(...args: Parameters<typeof accessRequest>) {
  const request = accessRequest(...args);
  return {
    ...request,
    [Symbol.dispose]() {
      request.req.destroy();
    },
  };
}

async function resolveWsProfileAdmission(request: ReturnType<typeof accessRequest>) {
  const admission = await resolveGatewayConnectProfileAdmission({
    context: {
      configSnapshot: request.cfg,
      handler: {
        connId: "oidc-profile-admission",
        logWsControl: createSubsystemLogger("test/oidc-profile-admission"),
        close: vi.fn(),
      },
      markHandshakeFailure: vi.fn(),
      sendHandshakeErrorResponse: vi.fn(),
      releasePendingNodePairingCleanup: async () => {},
    },
    state: {
      authResult: request.authResult,
      authMethod: request.authResult.method,
      role: "operator",
    },
    ownerProfileExpected: false,
    authenticatedUserId: request.authResult.user,
    resolveAuthenticatedGitHubIdentity: createAuthenticatedGitHubIdentitySync({
      authResult: request.authResult,
      authConfig: request.cfg.gateway?.auth,
      requestHeaders: request.req.headers,
    }),
  });
  if (!admission.ok) {
    throw new Error("Expected admitted WebSocket profile");
  }
  return admission.prepared?.profile;
}

const it = baseIt.extend<{ state: void }>({
  state: [
    async ({ task: _task }, use) => {
      try {
        await withOpenClawTestState({ scenario: "minimal" }, async () => use());
      } finally {
        vi.restoreAllMocks();
        closeOpenClawStateDatabaseForTest();
      }
    },
    { auto: true },
  ],
});

describe("Cloudflare Access OIDC profile resolution", () => {
  it("prefers oidc_fields over custom claims for HTTP and WebSocket profiles and public credit", async () => {
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (url === `${accessOrigin}/cdn-cgi/access/get-identity`) {
        return identityResponse({ ...oidcIdentity(), custom: { [accountIdClaim]: "202" } });
      }
      expect(url).toBe("https://api.github.com/user/101");
      return identityResponse({ id: 101, login: "canonical-ada", name: "Ada" });
    });
    using request = disposableAccessRequest("ada@example.test", githubCfg);
    const http = await resolveAuthenticatedHttpUserProfile(request);
    const profileId = http.authenticatedUserProfile!.profileId;
    expect(http.operatorRolePolicy?.scopes).toEqual([]);
    expect(getUserProfileListItem(profileId)).toMatchObject({
      displayName: "Ada",
      emails: ["ada@example.test"],
      githubIdentity: { login: "canonical-ada" },
    });
    expect((await resolveUserProfileGitHubAttribution([profileId])).get(profileId)).toEqual({
      accountId: 101,
      login: "canonical-ada",
    });
    const connected = await resolveWsProfileAdmission(request);
    expect(connected).toEqual(http.authenticatedUserProfile);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each([
    { field: "custom", verified: false },
    { field: "custom", verified: true },
  ] as const)(
    "preserves email admission during $field lookup failure (verified=$verified)",
    async ({ field, verified }) => {
      const profile = verified
        ? syncGitHubIdentity({
            identity: { accountId: 101, login: "ada" },
            authenticationAlias: { kind: "email", email: "ada@example.test" },
          })
        : ensureProfileForEmail("ada@example.test");
      setUserProfileRole(profile.id, "maintainer");
      setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
      const before = getUserProfileListItem(profile.id);
      const transport = mockIdentityLookup(oidcIdentity("101", field), verified ? 404 : 503);
      using request = disposableAccessRequest("ada@example.test", githubCfg);
      const http = await resolveAuthenticatedHttpUserProfile(request);
      expect(http.authenticatedUserProfile?.profileId).toBe(profile.id);
      expect(http.operatorRolePolicy?.scopes).toEqual(["operator.admin"]);
      expect(await resolveWsProfileAdmission(request)).toEqual(http.authenticatedUserProfile);
      expect(getUserProfileListItem(profile.id)).toEqual(before);
      await expectNoAttribution(profile.id);
      expectCreditDisabled(profile.id);

      setUserProfileRole(profile.id, null);
      invalidateOperatorRolePolicy(profile.id);
      expect(
        (await resolveAuthenticatedHttpUserProfile(request)).operatorRolePolicy?.scopes,
      ).toEqual([]);

      transport.mockImplementation(async (url) =>
        identityResponse(url === accessIdentityUrl ? oidcIdentity("101", field) : githubIdentity),
      );
      expect(
        (await resolveAuthenticatedHttpUserProfile(request)).authenticatedUserProfile?.profileId,
      ).toBe(profile.id);
      expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("canonical-ada");
      expectCreditDisabled(profile.id);
    },
  );

  it.each<{
    name: string;
    config?: typeof cfg;
    issuer?: string;
    identity?: unknown;
  }>([
    { name: "no opt-in", config: cfg },
    { name: "different issuer", issuer: "https://other.cloudflareaccess.com" },
    {
      name: "different provider",
      identity: { ...oidcIdentity(), idp: { type: "oidc", id: "other" } },
    },
    {
      name: "preferred container without the claim",
      identity: { ...oidcIdentity(), oidc_fields: {}, custom: { [accountIdClaim]: "101" } },
    },
    {
      name: "null preferred container",
      identity: { ...oidcIdentity(), oidc_fields: null, custom: { [accountIdClaim]: "101" } },
    },
    ...[101, "01", "9007199254740992"].map((claim) => ({
      name: `malformed trusted account claim ${JSON.stringify(claim)}`,
      identity: { ...oidcIdentity(claim), custom: { [accountIdClaim]: "101" } },
    })),
  ])("keeps email-only sign-in with $name", async ({ config, issuer, identity }) => {
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(identityResponse(identity ?? oidcIdentity()));
    using request = disposableAccessRequest("ada@example.test", config ?? githubCfg, issuer);
    const result = await resolveAuthenticatedHttpUserProfile(request);
    const profileId = result.authenticatedUserProfile!.profileId;
    expect(result.operatorRolePolicy?.scopes).toEqual([]);
    expect(getUserProfileListItem(profileId)).toMatchObject({
      emails: ["ada@example.test"],
      githubIdentity: null,
    });
    await expectNoAttribution(profileId);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(["different account", "different profile"])(
    "rejects a %s conflict without merging profiles or moving the email",
    async (conflict) => {
      const existing = syncGitHubIdentity({
        identity: { accountId: conflict === "different account" ? 202 : 101, login: "existing" },
        authenticationAlias: {
          kind: "email",
          email: conflict === "different account" ? "ada@example.test" : "other@example.test",
        },
      });
      const emailProfile = ensureProfileForEmail("ada@example.test");
      setUserProfileRole(emailProfile.id, "maintainer");
      const before = [getUserProfileListItem(existing.id), getUserProfileListItem(emailProfile.id)];
      const transport = vi.spyOn(globalThis, "fetch");
      using request = disposableAccessRequest("ada@example.test", githubCfg);
      for (const status of [503, 200]) {
        transport
          .mockResolvedValueOnce(identityResponse(oidcIdentity("101", "custom")))
          .mockResolvedValueOnce(identityResponse({ id: 101, login: "canonical-ada" }, status));
        await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow(
          "users.linkEmail",
        );
        expect([
          getUserProfileListItem(existing.id),
          getUserProfileListItem(emailProfile.id),
        ]).toEqual(before);
      }
    },
  );

  it("requires explicit linking before a new email can use an existing profile's authority", async () => {
    const maintainer = syncGitHubIdentity({
      identity: { accountId: 101, login: "canonical-ada" },
      authenticationAlias: { kind: "email", email: "owner@example.test" },
    });
    setUserProfileRole(maintainer.id, "maintainer");
    setUserPreferences(maintainer.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
    const before = getUserProfileListItem(maintainer.id);
    const transport = mockIdentityLookup();
    using request = disposableAccessRequest("ada@example.test", githubCfg);
    await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow("users.linkEmail");
    expect(getUserProfileListItem(maintainer.id)).toEqual(before);

    transport.mockResolvedValueOnce(identityResponse({ ...oidcIdentity(), oidc_fields: {} }));
    const emailOnly = await resolveAuthenticatedHttpUserProfile(request);
    expect(emailOnly.authenticatedUserProfile?.profileId).not.toBe(maintainer.id);
    expect(emailOnly.operatorRolePolicy?.scopes).toEqual([]);

    linkEmail("ada@example.test", maintainer.id);
    const linked = await resolveAuthenticatedHttpUserProfile(request);
    expect(linked.authenticatedUserProfile?.profileId).toBe(maintainer.id);
    expect(linked.operatorRolePolicy?.scopes).toEqual(["operator.admin"]);
    await expectNoAttribution(maintainer.id);

    setUserProfileRole(maintainer.id, null);
    invalidateOperatorRolePolicy(maintainer.id);
    const restricted = await resolveAuthenticatedHttpUserProfile(request);
    expect(restricted.authenticatedUserProfile?.profileId).toBe(maintainer.id);
    expect(restricted.operatorRolePolicy?.scopes).toEqual([]);

    transport.mockResolvedValueOnce(identityResponse({}, 401));
    await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow(
      "Cloudflare Access identity lookup failed",
    );
  });

  it("reuses an existing email profile and role for HTTP and WebSocket connections", async () => {
    const profile = ensureProfileForEmail("ada@example.test");
    setUserProfileRole(profile.id, "maintainer");
    const before = getUserProfileListItem(profile.id);
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      identityResponse({
        id: "oidc-subject-101",
        email: "ADA@Example.Test",
        name: "OIDC display name",
        idp: { type: "oidc" },
      }),
    );
    using request = disposableAccessRequest();
    const queries = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      const httpProfile = await resolveAuthenticatedHttpUserProfile(request);
      expect(httpProfile.authenticatedUserProfile?.profileId).toBe(profile.id);
      expect(httpProfile.operatorRolePolicy?.scopes).toEqual(["operator.admin"]);
      const connectedProfile = await resolveWsProfileAdmission(request);
      expect(connectedProfile).toEqual(httpProfile.authenticatedUserProfile);
      expect(queries).not.toHaveBeenCalled();
      queries.mockRestore();
      expect(getUserProfileListItem(profile.id)).toEqual(before);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls.every(([url]) => url === accessIdentityUrl)).toBe(true);
    } finally {
      queries.mockRestore();
    }
  });

  it("gives a new OIDC email its own default-role profile without interpreting its subject as GitHub", async () => {
    const existing = syncGitHubIdentity({
      identity: { accountId: 101, login: "ada" },
      authenticationAlias: { kind: "email", email: "ada@example.test" },
    });
    setUserProfileRole(existing.id, "maintainer");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      identityResponse({
        id: 101,
        email: "grace@example.test",
        idp: { type: "oidc" },
      }),
    );
    using request = disposableAccessRequest("grace@example.test");
    const result = await resolveAuthenticatedHttpUserProfile(request);
    const profileId = result.authenticatedUserProfile?.profileId;
    expect(profileId).toBeTypeOf("string");
    expect(profileId).not.toBe(existing.id);
    expect(result.operatorRolePolicy?.scopes).toEqual([]);
    expect(getUserProfileListItem(profileId!)).toMatchObject({
      emails: ["grace@example.test"],
      githubIdentity: null,
    });
  });

  it.each([
    { name: "missing principal", idp: { type: "oidc" } },
    { name: "missing provider", email: "ada@example.test" },
    { name: "unknown provider", email: "ada@example.test", idp: { type: "unknown" } },
  ])("rejects $name without changing an existing profile", async ({ name: _name, ...identity }) => {
    const profile = ensureProfileForEmail("ada@example.test");
    setUserProfileRole(profile.id, "maintainer");
    const before = getUserProfileListItem(profile.id);
    const changed = vi.fn();
    const stop = onUserProfilesChanged(changed);
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(identityResponse(identity));
    using request = disposableAccessRequest();
    try {
      await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow();
      expect(getUserProfileListItem(profile.id)).toEqual(before);
      expect(changed).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
});

function requestIdentity(exp: unknown, signature = "signature", principal = "ada@example.test") {
  const request = accessRequest(principal, githubCfg);
  request.req.headers["cf-access-jwt-assertion"] =
    `header.${Buffer.from(JSON.stringify({ iss: accessOrigin, exp })).toString("base64url")}.${signature}`;
  request.req.destroy();
  return {
    authResult: request.authResult,
    authConfig: request.cfg.gateway?.auth,
    requestHeaders: request.req.headers,
  };
}

function resolveCachedIdentity(params: ReturnType<typeof requestIdentity>) {
  return createAuthenticatedGitHubIdentitySync(params)!();
}

it("rechecks current profile roles while reusing the same verified assertion", async () => {
  const profile = ensureProfileForEmail("ada@example.test");
  setUserProfileRole(profile.id, "maintainer");
  const transport = mockEmailIdentity();
  using request = disposableAccessRequest("ada@example.test", githubCfg);
  request.req.headers = requestIdentity(Math.floor(Date.now() / 1_000) + 600).requestHeaders;
  expect((await resolveAuthenticatedHttpUserProfile(request)).operatorRolePolicy?.scopes).toEqual([
    "operator.admin",
  ]);
  setUserProfileRole(profile.id, null);
  invalidateOperatorRolePolicy(profile.id);
  expect((await resolveAuthenticatedHttpUserProfile(request)).operatorRolePolicy?.scopes).toEqual(
    [],
  );
  expect(transport).toHaveBeenCalledOnce();
});

it("coalesces concurrent assertions and reuses their verified result without extra network calls", async () => {
  const pending = Promise.withResolvers<Response>();
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) =>
      url === accessIdentityUrl ? pending.promise : identityResponse({ id: 101, login: "ada" }),
    );
  const params = requestIdentity(Math.floor(Date.now() / 1_000) + 600);
  const first = resolveCachedIdentity(params);
  const second = resolveCachedIdentity(params);
  pending.resolve(identityResponse(oidcIdentity()));
  const [a, b] = await Promise.all([first, second]);
  expect(a.profileId).toBe(b.profileId);
  expect((await resolveCachedIdentity(params)).profileId).toBe(a.profileId);
  expect(transport.mock.calls.map(([url]) => url)).toEqual([
    accessIdentityUrl,
    "https://api.github.com/user/101",
  ]);
});

it("partitions signed assertions, principals, and OIDC configuration", async () => {
  const transport = mockIdentityLookup();
  const exp = Math.floor(Date.now() / 1_000) + 600;
  const params = requestIdentity(exp);
  await resolveCachedIdentity(params);
  await resolveCachedIdentity(requestIdentity(exp, "different"));
  await expect(
    resolveCachedIdentity(requestIdentity(exp, "signature", "wrong@example.test")),
  ).rejects.toThrow("principal did not match");
  const changed = structuredClone(params);
  changed.authConfig!.trustedProxy!.cloudflareAccessOidc!.providerId = "other";
  await resolveCachedIdentity(changed);
  expect(transport.mock.calls.filter(([url]) => url === accessIdentityUrl)).toHaveLength(4);
});

it("keeps pending verification bound to the OIDC policy used by its cache key", async () => {
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (url === accessIdentityUrl) {
      entered.resolve();
      return response.promise;
    }
    return identityResponse({ id: 101, login: "ada" });
  });
  const params = structuredClone(requestIdentity(Math.floor(Date.now() / 1_000) + 600));
  const policy = params.authConfig!.trustedProxy!.cloudflareAccessOidc!;
  const originalProvider = policy.providerId;
  const pending = resolveCachedIdentity(params);
  await entered.promise;
  policy.providerId = "other";
  response.resolve(identityResponse({ ...oidcIdentity(), idp: { type: "oidc", id: "other" } }));
  const result = await pending;
  policy.providerId = originalProvider;
  expect((await resolveCachedIdentity(params)).profileId).toBe(result.profileId);
  expect(getUserProfileListItem(result.profileId).githubIdentity).toBeNull();
  expect(transport).toHaveBeenCalledOnce();
});

it.each([30, 600])(
  "expires at the earlier of assertion expiry and five minutes (%s seconds)",
  async (ttl) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const transport = mockEmailIdentity();
    const params = requestIdentity(Math.floor(now / 1_000) + ttl);
    await resolveCachedIdentity(params);
    clock.mockReturnValue(now + Math.min(ttl, 300) * 1_000);
    await resolveCachedIdentity(params);
    expect(transport).toHaveBeenCalledTimes(2);
  },
);

it.each([undefined, "invalid", 0])(
  "does not cache assertions without a future numeric expiry (%s)",
  async (exp) => {
    const transport = mockEmailIdentity();
    const params = requestIdentity(exp);
    await resolveCachedIdentity(params);
    await resolveCachedIdentity(params);
    expect(transport).toHaveBeenCalledTimes(2);
  },
);

it.each(["network", "principal"])("does not cache %s failures", async (failure) => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      identityResponse({ email: "wrong@example.test" }, failure === "network" ? 503 : 200),
    )
    .mockResolvedValueOnce(identityResponse(emailIdentity));
  const params = requestIdentity(Math.floor(Date.now() / 1_000) + 600);
  await expect(resolveCachedIdentity(params)).rejects.toThrow();
  await expect(resolveCachedIdentity(params)).resolves.toHaveProperty("profileId");
  expect(transport).toHaveBeenCalledTimes(2);
});
