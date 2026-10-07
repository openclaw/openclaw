import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import {
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profile-writes.worker.js";
import {
  ensureProfileForTailscaleIdentity,
  getUserProfileDisplay,
  getUserProfileListItem,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildAuthenticatedPresenceUser } from "./authenticated-presence-user.js";
import type { ControlUiGitHubError } from "./github-public-api.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

function githubResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function accessAssertion(issuer: unknown): string {
  const payload = Buffer.from(JSON.stringify({ iss: issuer })).toString("base64url");
  return `header.${payload}.signature`;
}

function tailscaleSync(login = "ada", name = "Ada") {
  return createAuthenticatedGitHubIdentitySync({
    authResult: {
      ok: true,
      method: "tailscale",
      user: `${login}@github`,
      tailscaleIdentity: { login: `${login}@github`, name },
    },
  });
}

function cloudflareSync(params: {
  principal?: string;
  assertion?: string;
  userHeader?: string;
  requiredHeaders?: string[];
}) {
  return createAuthenticatedGitHubIdentitySync({
    authResult: {
      ok: true,
      method: "trusted-proxy",
      user: params.principal ?? "ada@example.com",
    },
    authConfig: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: params.userHeader ?? "cf-access-authenticated-user-email",
        requiredHeaders: params.requiredHeaders ?? ["CF-Access-JWT-Assertion"],
      },
    },
    requestHeaders: {
      "cf-access-authenticated-user-email": params.principal ?? "ada@example.com",
      "cf-access-jwt-assertion":
        params.assertion ?? accessAssertion("https://team.cloudflareaccess.com"),
    },
  });
}

const ACCESS_ORIGIN = "https://team.cloudflareaccess.com";
const CACHE_TTL_MS = 15 * 60_000;

function jsonResponse(value: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { headers });
}

function accessParams(
  principal = "ada@example.test",
): Parameters<typeof createAuthenticatedGitHubIdentitySync>[0] {
  return {
    authResult: { ok: true, method: "trusted-proxy", user: principal },
    authConfig: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
      },
    },
    requestHeaders: {
      "cf-access-jwt-assertion": `header.${Buffer.from(JSON.stringify({ iss: ACCESS_ORIGIN })).toString("base64url")}.signature`,
    },
  };
}

function createAccessSync(principal?: string) {
  const sync = createAuthenticatedGitHubIdentitySync(accessParams(principal));
  assert(sync);
  return sync;
}

function stubIdentityFetch(
  metadata: typeof fetch,
  access = { id: 101, email: "ada@example.test" },
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(ACCESS_ORIGIN)) {
      return jsonResponse({ ...access, idp: { type: "github" } });
    }
    return metadata(input, init);
  });
}

beforeEach(() => {
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
});

describe("authenticated GitHub identity sync", () => {
  it("verifies public Access identity without using the Enterprise repository credential", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({
        gateway: {
          github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
          controlUi: {
            github: { host: "ghe.example.test", token: "enterprise-service-token" },
          },
        },
      });
      vi.stubEnv("GH_TOKEN", "configured-service-token");
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const authorization = new Headers(init?.headers).get("Authorization");
        if (url.startsWith("https://team.cloudflareaccess.com/")) {
          expect(authorization).toBeNull();
          return githubResponse({
            id: 583231,
            email: "ada@example.com",
            idp: { type: "github" },
          });
        }
        expect(url).toBe("https://api.github.com/user/583231");
        return authorization === "Bearer configured-service-token"
          ? githubResponse({ id: 583231, login: "Ada" })
          : githubResponse({}, 403, { "x-ratelimit-remaining": "0" });
      });
      const sync = cloudflareSync({});
      const result = await sync!();
      expect(getUserProfileListItem(result.profileId).githubIdentity).toMatchObject({
        login: "Ada",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    { provider: "tailscale", name: 123, initial: "Provider Ada", expected: "Provider Ada" },
    { provider: "access", name: 123, initial: "Provider Ada", expected: "Provider Ada" },
    { provider: "access", name: undefined, initial: undefined, expected: null },
  ])(
    "preserves $provider display fallback $expected without extra requests",
    async ({ provider, name, initial, expected }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        if (provider === "access") {
          fetchMock.mockResolvedValueOnce(
            githubResponse({
              id: 583231,
              email: "ada@example.com",
              name: initial,
              idp: { type: "github" },
            }),
          );
        }
        fetchMock.mockResolvedValueOnce(githubResponse({ id: 583231, login: "Ada", name }));
        const sync =
          provider === "access" ? cloudflareSync({}) : tailscaleSync("ada", initial ?? "");
        const result = await sync!();
        const display = getUserProfileDisplay(result.profileId);
        expect(display.displayName).toBe(expected);
        const presenceUser = buildAuthenticatedPresenceUser({
          authenticatedUserId: provider === "access" ? "ada@example.com" : "ada@github",
          authenticatedUserIsTailscaleProvider: provider === "tailscale",
          authenticatedUserProfile: { profileId: display.id, ...display },
        });
        expect(presenceUser?.name).toBe(expected ?? undefined);
        expect(presenceUser?.id).toBe(result.profileId);
        await sync!();
        expect(fetchMock).toHaveBeenCalledTimes(provider === "access" ? 2 : 1);
      });
    },
  );

  it("preserves the sign-in resolver's existing optional-auth recovery", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({
        gateway: { controlUi: { github: { token: "synthetic-stale-service-token" } } },
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(githubResponse({}, 401))
        .mockResolvedValueOnce(githubResponse({ id: 42, login: "Visitor" }));
      await expect(tailscaleSync("visitor")?.()).resolves.toHaveProperty("profileId");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
        "Bearer synthetic-stale-service-token",
      );
      expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
    });
  });

  it("rejects a malformed public GitHub account id", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(githubResponse({ id: "583231" }));
      await expect(tailscaleSync("octocat", "Octo Cat")?.()).rejects.toMatchObject({
        statusCode: 502,
      } satisfies Partial<ControlUiGitHubError>);
    });
  });

  it("deduplicates concurrent sync and preserves a custom edit during the lookup", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "ada@github" });
      setDisplayName(profile.id, "Ada");
      let resolveLookup: ((response: Response) => void) | undefined;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
        async () =>
          await new Promise<Response>((resolve) => {
            resolveLookup = resolve;
          }),
      );

      const sync = tailscaleSync();
      const first = sync?.();
      const second = sync?.();
      expect(second).toBe(first);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      setDisplayName(profile.id, "User Chosen");
      resolveLookup?.(githubResponse({ id: 583231, login: "Ada", name: "Ada Lovelace" }));

      await expect(first).resolves.toMatchObject({ profileId: profile.id });
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({ login: "Ada" });
      expect(getUserProfileDisplay(profile.id).displayName).toBe("User Chosen");
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it("reuses only the exact verified login binding during a GitHub outage", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(githubResponse({ id: 583231, login: "Ada" }))
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce(githubResponse({ id: 700, login: "eve" }))
        .mockResolvedValueOnce(githubResponse({ id: 583231, login: "ada-renamed" }))
        .mockRejectedValueOnce(new Error("network unavailable"));

      const { profileId } = await tailscaleSync()!();
      await expect(tailscaleSync()!()).resolves.toMatchObject({ profileId });
      expect(getUserProfileListItem(profileId).githubIdentity).toMatchObject({ login: "Ada" });

      const unverifiedConnection = tailscaleSync("eve")!;
      await expect(unverifiedConnection()).rejects.toMatchObject({ statusCode: 502 });
      await expect(unverifiedConnection()).resolves.not.toMatchObject({ profileId });

      await expect(tailscaleSync("ada-renamed")!()).resolves.toMatchObject({ profileId });
      await expect(tailscaleSync()!()).rejects.toMatchObject({ statusCode: 502 });
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
  });

  it("activates only the standard required-header Cloudflare Access contract", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(cloudflareSync({})).toBeTypeOf("function");
      expect(cloudflareSync({ userHeader: "x-forwarded-user" })).toBeUndefined();
      expect(cloudflareSync({ requiredHeaders: ["x-forwarded-proto"] })).toBeUndefined();
    });
  });

  it.each([
    { name: "malformed JWT", assertion: "not-a-jwt" },
    { name: "oversized JWT", assertion: "x".repeat(16 * 1024 + 1) },
    { name: "non-HTTPS issuer", issuer: "http://team.cloudflareaccess.com" },
    { name: "credentialed issuer", issuer: "https://user@team.cloudflareaccess.com" },
    { name: "non-root issuer", issuer: "https://team.cloudflareaccess.com/path" },
    { name: "hostile suffix", issuer: "https://team.cloudflareaccess.com.evil.test" },
  ])("rejects a $name before network access", async ({ assertion, issuer }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const sync = cloudflareSync({
        assertion: assertion ?? accessAssertion(issuer),
      });
      await expect(sync?.()).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: "non-object response", access: githubResponse([]) },
    {
      name: "invalid account id",
      access: githubResponse({
        id: "58493",
        email: "ada@example.com",
        idp: { type: "github" },
      }),
    },
  ])("fails safely for a $name", async ({ access }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "ada@passkey" });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(access);
      const sync = cloudflareSync({});
      await expect(sync?.()).rejects.toThrow();
      expect(getUserProfileListItem(profile.id).githubIdentity).toBeNull();
    });
  });

  it("rejects a GitHub account-id mismatch without erasing prior identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      setRuntimeConfigSnapshot({
        gateway: { controlUi: { github: { token: "configured-service-token" } } },
      });
      const initialFetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));
      const first = await cloudflareSync({})?.();
      expect(initialFetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
      clock.mockReturnValue(1_800_000_000_000 + 15 * 60_000);
      initialFetch
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 99999, login: "mallory" }));

      await expect(cloudflareSync({})?.()).rejects.toThrow();
      expect(getUserProfileListItem(first!.profileId).githubIdentity).toMatchObject({
        login: "steipete",
      });
    });
  });

  it.each([
    { name: "GitHub permission denial", githubStatus: 403 },
    { name: "different cached account", githubStatus: 429, accessAccountId: 99999 },
    { name: "different cached email", githubStatus: 429, principal: "mallory@example.com" },
    {
      name: "email and account on different profiles",
      githubStatus: 429,
      accessAccountId: 99999,
      otherProfile: true,
    },
    { name: "missing cached identity", githubStatus: 429, seedCache: false },
  ])(
    "fails closed for a $name",
    async ({ githubStatus, accessAccountId, principal, otherProfile, seedCache }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        if (seedCache !== false) {
          syncGitHubIdentity({
            identity: { accountId: 58493, login: "steipete" },
            authenticationAlias: { kind: "email", email: "ada@example.com" },
          });
        }
        if (otherProfile) {
          syncGitHubIdentity({
            identity: { accountId: 99999, login: "mallory" },
            authenticationAlias: { kind: "email", email: "mallory@example.com" },
          });
        }
        const authenticatedEmail = principal ?? "ada@example.com";
        const fetchMock = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(
            githubResponse({
              id: accessAccountId ?? 58493,
              email: authenticatedEmail,
              idp: { type: "github" },
            }),
          )
          .mockResolvedValueOnce(githubResponse({}, githubStatus));

        await expect(cloudflareSync({ principal: authenticatedEmail })?.()).rejects.toMatchObject({
          statusCode: githubStatus,
        } satisfies Partial<ControlUiGitHubError>);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("redacts the Access assertion from network failures and retries on the same connection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const assertion = accessAssertion("https://team.cloudflareaccess.com");
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error(`network rejected ${assertion}`))
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));
      const sync = cloudflareSync({ assertion });

      const error = await sync?.().catch((failure: unknown) => failure);
      expect(String(error)).not.toContain(assertion);
      const result = await sync?.();
      expect(result?.profileId).toBeTypeOf("string");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});

describe("GitHub public identity metadata cache", () => {
  it("deduplicates concurrent metadata without caching Access verification or local profiles", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const gate = createDeferred();
      const metadataStarted = createDeferred();
      const metadata = vi.fn<typeof fetch>().mockImplementation(async () => {
        metadataStarted.resolve();
        await gate.promise;
        return jsonResponse({ id: 101, login: "ada", name: "Ada" });
      });
      const transport = stubIdentityFetch(metadata);
      const requests = [createAccessSync()(), createAccessSync()()] as const;
      const pending = Promise.all(requests);
      try {
        await Promise.race([
          metadataStarted.promise,
          pending.then(() => {
            throw new Error("Identity sync completed before the metadata request started");
          }),
        ]);
        expect(transport).toHaveBeenCalledTimes(metadata.mock.calls.length + 2);
        gate.resolve();
        const [first, second] = await pending;
        expect(second.profileId).toBe(first.profileId);
        expect(metadata).toHaveBeenCalledOnce();
        setDisplayName(first.profileId, "Locally Edited");
        await createAccessSync()();
        expect(getUserProfileListItem(first.profileId).displayName).toBe("Locally Edited");
        expect(metadata).toHaveBeenCalledOnce();
        expect(transport).toHaveBeenCalledTimes(4);
      } finally {
        gate.resolve();
        await Promise.allSettled(requests);
      }
    });
  });

  it("renews unchanged metadata without changing profiles and publishes a real rename", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const metadata = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }, { etag: '"profile-v1"' }))
        .mockResolvedValueOnce(new Response(null, { status: 304 }))
        .mockResolvedValueOnce(
          jsonResponse({ id: 101, login: "ada-renamed" }, { etag: '"profile-v2"' }),
        );
      stubIdentityFetch(metadata);
      const first = await createAccessSync()();
      const display = getUserProfileDisplay(first.profileId);
      const initialProfile = getUserProfileListItem(first.profileId);
      const changed = vi.fn();
      const stop = onUserProfilesChanged(changed);
      try {
        clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS - 1);
        await expect(createAccessSync()()).resolves.toMatchObject({ profileId: first.profileId });
        expect(metadata).toHaveBeenCalledOnce();
        clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS);
        const renewed = await Promise.all(Array.from({ length: 8 }, () => createAccessSync()()));
        expect(renewed).toEqual(Array.from({ length: 8 }, () => first));
        expect(changed).not.toHaveBeenCalled();
        expect(getUserProfileDisplay(first.profileId)).toEqual(display);
        expect(getUserProfileListItem(first.profileId)).toEqual(initialProfile);
        expect(new Headers(metadata.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe(
          '"profile-v1"',
        );
        clock.mockReturnValue(1_800_000_000_000 + 2 * CACHE_TTL_MS - 1);
        await createAccessSync()();
        expect(metadata).toHaveBeenCalledTimes(2);
        clock.mockReturnValue(1_800_000_000_000 + 2 * CACHE_TTL_MS);
        const renamed = await createAccessSync()();
        const persisted = getUserProfileListItem(first.profileId);
        expect(persisted.githubIdentity?.login).toBe("ada-renamed");
        expect(renamed).toEqual({ profileId: first.profileId, updatedAt: persisted.updatedAt });
        expect(metadata).toHaveBeenCalledTimes(3);
        expect(changed).toHaveBeenCalledOnce();
      } finally {
        stop();
      }
    });
  });

  it("separates account and credential keys and rejects unavailable configured credentials", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const access = { id: 101, email: "ada@example.test" };
      const metadata = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          jsonResponse(
            { id: access.id, login: access.id === 101 ? "ada" : "grace" },
            { etag: '"metadata-v1"' },
          ),
        );
      stubIdentityFetch(metadata, access);
      setRuntimeConfigSnapshot({ gateway: { controlUi: { github: { token: "first-token" } } } });
      await createAccessSync()();
      setRuntimeConfigSnapshot({ gateway: { controlUi: { github: { token: "second-token" } } } });
      await createAccessSync()();
      expect(new Headers(metadata.mock.calls[1]?.[1]?.headers).has("if-none-match")).toBe(false);
      access.id = 102;
      const second = await createAccessSync()();
      expect(getUserProfileListItem(second.profileId).githubIdentity?.login).toBe("grace");
      expect(metadata).toHaveBeenCalledTimes(3);
      vi.stubEnv("GH_TOKEN", "other-process-token");
      setRuntimeConfigSnapshot({
        gateway: {
          controlUi: {
            github: { token: { source: "env", provider: "default", id: "UNAVAILABLE_TOKEN" } },
          },
        },
      });
      await expect(createAccessSync()()).rejects.toBeInstanceOf(SecretSurfaceUnavailableError);
      expect(metadata).toHaveBeenCalledTimes(3);
    });
  });

  it("never reuses an anonymous ETag for an authenticated refresh", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      setRuntimeConfigSnapshot({ gateway: { controlUi: { github: { token: "service-token" } } } });
      const metadata = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }, { etag: '"anonymous-v1"' }))
        .mockResolvedValueOnce(
          jsonResponse({ id: 101, login: "ada" }, { etag: '"authenticated-v1"' }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 304 }));
      stubIdentityFetch(metadata);
      await createAccessSync()();
      await createAccessSync()();
      expect(new Headers(metadata.mock.calls[2]?.[1]?.headers).get("if-none-match")).toBeNull();
      clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS);
      await createAccessSync()();
      expect(new Headers(metadata.mock.calls[3]?.[1]?.headers).get("if-none-match")).toBe(
        '"authenticated-v1"',
      );
      expect(metadata).toHaveBeenCalledTimes(4);
    });
  });

  it("rechecks live Access and local role revocation on HTTP metadata cache hits", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const access = { id: 101, email: "ada@example.test" };
      const metadata = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => jsonResponse({ id: 101, login: "ada" }));
      const transport = stubIdentityFetch(metadata, access);
      const auth = accessParams();
      const req = new IncomingMessage(new Socket());
      req.headers = auth.requestHeaders ?? {};
      const cfg = {
        gateway: {
          auth: auth.authConfig,
          roles: {
            default: "guest",
            definitions: {
              maintainer: {
                sessions: { others: "view" as const },
                agents: "*" as const,
                scopes: ["operator.admin" as const],
              },
              guest: { sessions: { others: "none" as const }, agents: [] as string[], scopes: [] },
            },
          },
        },
      };
      const changed = vi.fn();
      const stop = onUserProfilesChanged(changed);
      try {
        setRuntimeConfigSnapshot(cfg);
        const resolve = () =>
          resolveAuthenticatedHttpUserProfile({ authResult: auth.authResult, req, cfg });
        const first = await resolve();
        assert(first.authenticatedUserProfile);
        const profileId = first.authenticatedUserProfile.profileId;
        changed.mockClear();
        clock.mockReturnValue(1_800_000_001_000);
        const warm = await resolve();
        expect(changed).not.toHaveBeenCalled();
        expect(warm.authenticatedUserProfile?.updatedAt).toBe(
          first.authenticatedUserProfile.updatedAt,
        );
        setUserProfileRole(profileId, "maintainer");
        invalidateOperatorRolePolicy(profileId);
        expect((await resolve()).operatorRolePolicy?.scopes).toContain("operator.admin");
        setUserProfileRole(profileId, null);
        invalidateOperatorRolePolicy(profileId);
        expect((await resolve()).operatorRolePolicy?.scopes).toEqual([]);
        access.email = "other@example.test";
        await expect(resolve()).rejects.toThrow("principal did not match");
        expect(metadata).toHaveBeenCalledOnce();
        expect(transport).toHaveBeenCalledTimes(6);
      } finally {
        stop();
        req.destroy();
      }
    });
  });

  it("uses only an exact durable binding during expired metadata quota cooldown", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const access = { id: 101, email: "ada@example.test" };
      const metadata = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }))
        .mockImplementation(
          async () => new Response(null, { status: 429, headers: { "retry-after": "90" } }),
        );
      stubIdentityFetch(metadata, access);
      const first = await createAccessSync()();
      clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS);
      await expect(createAccessSync()()).resolves.toMatchObject({ profileId: first.profileId });
      await expect(createAccessSync()()).resolves.toMatchObject({ profileId: first.profileId });
      access.email = "new-principal@example.test";
      await expect(createAccessSync(access.email)()).rejects.toMatchObject({ statusCode: 429 });
      expect(metadata).toHaveBeenCalledTimes(2);
    });
  });

  it("reverifies mutable Tailscale logins when an account name is reassigned", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }))
        .mockResolvedValueOnce(jsonResponse({ id: 102, login: "ada" }));
      const sync = () => {
        const resolve = createAuthenticatedGitHubIdentitySync({
          authResult: {
            ok: true,
            method: "tailscale",
            user: "ada@github",
            tailscaleIdentity: { login: "ada@github", name: "Ada" },
          },
        });
        assert(resolve);
        return resolve();
      };
      const first = await sync();
      const second = await sync();
      expect(second.profileId).not.toBe(first.profileId);
      expect(transport).toHaveBeenCalledTimes(2);
    });
  });
});
