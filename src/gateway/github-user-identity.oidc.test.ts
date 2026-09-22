import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { resolveUserProfileGitHubAttribution } from "../state/user-profile-github-identity.js";
import {
  ensureProfileForEmail,
  getUserProfileListItem,
  linkEmail,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { resolveGatewayConnectProfileAdmission } from "./server/ws-connection/connect-user-profile.js";

const accessOrigin = "https://team.cloudflareaccess.com";
const accountIdClaim = "https://openclaw.ai/github-account-id";
const oidcProviderId = "verified-oidc-provider";
const cfg: OpenClawConfig = {
  gateway: {
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
      },
    },
    roles: {
      default: "guest",
      definitions: {
        maintainer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.admin"] },
        guest: { sessions: { others: "none" }, agents: [], scopes: [] },
      },
    },
  },
};

const githubCfg: OpenClawConfig = {
  gateway: {
    ...cfg.gateway,
    auth: {
      ...cfg.gateway?.auth,
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
        cloudflareAccessOidc: {
          issuer: accessOrigin,
          providerId: oidcProviderId,
          githubAccountIdClaim: accountIdClaim,
        },
      },
    },
  },
};

function accessRequest(principal = "ada@example.test", config = cfg, issuer = accessOrigin) {
  setRuntimeConfigSnapshot(config);
  const req = new IncomingMessage(new Socket());
  req.headers = {
    "cf-access-authenticated-user-email": principal,
    "cf-access-jwt-assertion": `header.${Buffer.from(JSON.stringify({ iss: issuer })).toString("base64url")}.signature`,
  };
  const authResult = { ok: true, method: "trusted-proxy" as const, user: principal };
  return { req, authResult, cfg: config };
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

function identityResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function oidcIdentity(claim: unknown = "101") {
  return {
    id: "unrelated-oidc-subject",
    email: "ada@example.test",
    idp: { type: "oidc", id: oidcProviderId },
    oidc_fields: { [accountIdClaim]: claim },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("Cloudflare Access OIDC profile resolution", () => {
  it("verifies a trusted account claim for HTTP and WebSocket profiles and public credit", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (url === `${accessOrigin}/cdn-cgi/access/get-identity`) {
          return identityResponse(oidcIdentity());
        }
        expect(url).toBe("https://api.github.com/user/101");
        return identityResponse({ id: 101, login: "canonical-ada", name: "Ada" });
      });
      const request = accessRequest("ada@example.test", githubCfg);
      try {
        const http = await resolveAuthenticatedHttpUserProfile(request);
        const profileId = http.authenticatedUserProfile!.profileId;
        expect(http.operatorRolePolicy?.scopes).toEqual([]);
        expect(getUserProfileListItem(profileId)).toMatchObject({
          displayName: "Ada",
          emails: ["ada@example.test"],
          githubIdentity: { login: "canonical-ada" },
        });
        expect(resolveUserProfileGitHubAttribution([profileId]).get(profileId)).toEqual({
          accountId: 101,
          login: "canonical-ada",
        });
        const connected = await resolveWsProfileAdmission(request);
        expect(connected).toEqual(http.authenticatedUserProfile);
        expect(transport).toHaveBeenCalledTimes(3);
      } finally {
        request.req.destroy();
      }
    });
  });

  it.each(["email-only", "verified"])(
    "preserves an existing %s maintainer profile and saved credit opt-out",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile =
          kind === "verified"
            ? syncGitHubIdentity({
                identity: { accountId: 101, login: "old-ada" },
                authenticationAlias: { kind: "email", email: "ada@example.test" },
              })
            : ensureProfileForEmail("ada@example.test");
        setUserProfileRole(profile.id, "maintainer");
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
        vi.spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(identityResponse(oidcIdentity()))
          .mockResolvedValueOnce(identityResponse({ id: 101, login: "canonical-ada" }));
        const request = accessRequest("ada@example.test", githubCfg);
        try {
          const result = await resolveAuthenticatedHttpUserProfile(request);
          expect(result.authenticatedUserProfile?.profileId).toBe(profile.id);
          expect(result.operatorRolePolicy?.scopes).toEqual(["operator.admin"]);
          expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("canonical-ada");
          expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({
            [GIT_COAUTHOR_PREFERENCE_KEY]: false,
          });
          expect(resolveUserProfileGitHubAttribution([profile.id]).get(profile.id)).toBeNull();
        } finally {
          request.req.destroy();
        }
      });
    },
  );

  it.each([
    { name: "no opt-in", config: cfg },
    { name: "different issuer", issuer: "https://other.cloudflareaccess.com" },
    {
      name: "different provider",
      identity: { ...oidcIdentity(), idp: { type: "oidc", id: "other" } },
    },
    { name: "missing provider ID", identity: { ...oidcIdentity(), idp: { type: "oidc" } } },
    { name: "missing claim", identity: { ...oidcIdentity(), oidc_fields: {} } },
    { name: "different claim", identity: { ...oidcIdentity(), oidc_fields: { github_id: "101" } } },
  ])("keeps email-only sign-in with $name", async ({ config, issuer, identity }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(identityResponse(identity ?? oidcIdentity()));
      const request = accessRequest("ada@example.test", config ?? githubCfg, issuer);
      try {
        const result = await resolveAuthenticatedHttpUserProfile(request);
        expect(getUserProfileListItem(result.authenticatedUserProfile!.profileId)).toMatchObject({
          emails: ["ada@example.test"],
          githubIdentity: null,
        });
        expect(transport).toHaveBeenCalledOnce();
      } finally {
        request.req.destroy();
      }
    });
  });

  it.each([101, "0", "-1", "01", "1.5", "1e2", " 101", "9007199254740992", null])(
    "rejects malformed trusted account claim %j before GitHub lookup",
    async (claim) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const transport = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(identityResponse(oidcIdentity(claim)));
        const request = accessRequest("ada@example.test", githubCfg);
        try {
          await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow(
            "GitHub account id is invalid",
          );
          expect(transport).toHaveBeenCalledOnce();
        } finally {
          request.req.destroy();
        }
      });
    },
  );

  it.each(["different account", "different profile"])(
    "rejects a %s conflict without merging profiles or moving the email",
    async (conflict) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const existing = syncGitHubIdentity({
          identity: { accountId: conflict === "different account" ? 202 : 101, login: "existing" },
          authenticationAlias: {
            kind: "email",
            email: conflict === "different account" ? "ada@example.test" : "other@example.test",
          },
        });
        const emailProfile = ensureProfileForEmail("ada@example.test");
        setUserProfileRole(emailProfile.id, "maintainer");
        const before = [
          getUserProfileListItem(existing.id),
          getUserProfileListItem(emailProfile.id),
        ];
        vi.spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(identityResponse(oidcIdentity()))
          .mockResolvedValueOnce(identityResponse({ id: 101, login: "canonical-ada" }));
        const request = accessRequest("ada@example.test", githubCfg);
        try {
          await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow(
            "users.linkEmail",
          );
          expect([
            getUserProfileListItem(existing.id),
            getUserProfileListItem(emailProfile.id),
          ]).toEqual(before);
        } finally {
          request.req.destroy();
        }
      });
    },
  );

  it("preserves the primary account and consent after explicit secondary-account linking", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const primary = syncGitHubIdentity({
        identity: { accountId: 202, login: "primary" },
        authenticationAlias: { kind: "email", email: "primary@example.test" },
      });
      syncGitHubIdentity({
        identity: { accountId: 101, login: "secondary" },
        authenticationAlias: { kind: "email", email: "ada@example.test" },
      });
      linkEmail("ada@example.test", primary.id);
      setUserPreferences(primary.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(identityResponse(oidcIdentity()))
        .mockResolvedValueOnce(identityResponse({ id: 101, login: "secondary" }));
      const request = accessRequest("ada@example.test", githubCfg);
      try {
        const result = await resolveAuthenticatedHttpUserProfile(request);
        expect(result.authenticatedUserProfile?.profileId).toBe(primary.id);
        expect(getUserProfileListItem(primary.id).githubIdentity?.login).toBe("primary");
        expect(resolveUserProfileGitHubAttribution([primary.id]).get(primary.id)).toBeNull();
      } finally {
        request.req.destroy();
      }
    });
  });

  it("requires explicit linking before a new email can use an existing profile's authority", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const maintainer = syncGitHubIdentity({
        identity: { accountId: 101, login: "canonical-ada" },
        authenticationAlias: { kind: "email", email: "owner@example.test" },
      });
      setUserProfileRole(maintainer.id, "maintainer");
      setUserPreferences(maintainer.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
      const before = getUserProfileListItem(maintainer.id);
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url) =>
          identityResponse(
            url === `${accessOrigin}/cdn-cgi/access/get-identity`
              ? oidcIdentity()
              : { id: 101, login: "canonical-ada" },
          ),
        );
      const request = accessRequest("ada@example.test", githubCfg);
      try {
        await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow(
          "users.linkEmail",
        );
        expect(getUserProfileListItem(maintainer.id)).toEqual(before);

        transport.mockResolvedValueOnce(identityResponse({ ...oidcIdentity(), oidc_fields: {} }));
        const emailOnly = await resolveAuthenticatedHttpUserProfile(request);
        expect(emailOnly.authenticatedUserProfile?.profileId).not.toBe(maintainer.id);
        expect(emailOnly.operatorRolePolicy?.scopes).toEqual([]);

        linkEmail("ada@example.test", maintainer.id);
        const linked = await resolveAuthenticatedHttpUserProfile(request);
        expect(linked.authenticatedUserProfile?.profileId).toBe(maintainer.id);
        expect(linked.operatorRolePolicy?.scopes).toEqual(["operator.admin"]);
        expect(resolveUserProfileGitHubAttribution([maintainer.id]).get(maintainer.id)).toBeNull();

        setUserProfileRole(maintainer.id, null);
        invalidateOperatorRolePolicy(maintainer.id);
        const restricted = await resolveAuthenticatedHttpUserProfile(request);
        expect(restricted.authenticatedUserProfile?.profileId).toBe(maintainer.id);
        expect(restricted.operatorRolePolicy?.scopes).toEqual([]);

        transport.mockResolvedValueOnce(identityResponse({}, 401));
        await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow(
          "Cloudflare Access identity lookup failed",
        );
      } finally {
        request.req.destroy();
      }
    });
  });

  it.each(["email", "GitHub"])(
    "reuses an existing %s profile and role for HTTP and WebSocket connections",
    async (provider) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile =
          provider === "GitHub"
            ? syncGitHubIdentity({
                identity: { accountId: 101, login: "ada", name: "Ada" },
                authenticationAlias: { kind: "email", email: "ada@example.test" },
              })
            : ensureProfileForEmail("ada@example.test");
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
        const request = accessRequest();
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
          expect(
            transport.mock.calls.every(
              ([url]) => url === `${accessOrigin}/cdn-cgi/access/get-identity`,
            ),
          ).toBe(true);
        } finally {
          queries.mockRestore();
          request.req.destroy();
        }
      });
    },
  );

  it("gives a new OIDC email its own default-role profile without interpreting its subject as GitHub", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
      const request = accessRequest("grace@example.test");
      try {
        const result = await resolveAuthenticatedHttpUserProfile(request);
        const profileId = result.authenticatedUserProfile?.profileId;
        expect(profileId).toBeTypeOf("string");
        expect(profileId).not.toBe(existing.id);
        expect(result.operatorRolePolicy?.scopes).toEqual([]);
        expect(getUserProfileListItem(profileId!)).toMatchObject({
          emails: ["grace@example.test"],
          githubIdentity: null,
        });
      } finally {
        request.req.destroy();
      }
    });
  });

  it.each([
    { name: "mismatched principal", email: "other@example.test", idp: { type: "oidc" } },
    { name: "missing principal", idp: { type: "oidc" } },
    { name: "missing provider", email: "ada@example.test" },
    { name: "malformed provider", email: "ada@example.test", idp: { type: 1 } },
    { name: "unknown provider", email: "ada@example.test", idp: { type: "unknown" } },
    {
      name: "expired Access identity",
      email: "ada@example.test",
      idp: { type: "oidc" },
      status: 401,
    },
  ])(
    "rejects $name without changing an existing profile",
    async ({ name: _name, status, ...identity }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("ada@example.test");
        setUserProfileRole(profile.id, "maintainer");
        const before = getUserProfileListItem(profile.id);
        const changed = vi.fn();
        const stop = onUserProfilesChanged(changed);
        const transport = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(identityResponse(identity, status));
        const request = accessRequest();
        try {
          await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow();
          expect(getUserProfileListItem(profile.id)).toEqual(before);
          expect(changed).not.toHaveBeenCalled();
          expect(transport).toHaveBeenCalledOnce();
        } finally {
          stop();
          request.req.destroy();
        }
      });
    },
  );
});
