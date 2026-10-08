import type { IncomingMessage } from "node:http";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  isUserProfileCatalogReady,
  prepareUserProfileCatalog,
} from "../state/user-profile-list.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveControlUiPluginAuthCookieGrants,
  setControlUiPluginAuthCookie,
} from "./control-ui-plugin-auth-cookie.js";
import { createGatewayRequest } from "./hooks-test-helpers.js";
import {
  authorizeControlUiPluginCookieRequest,
  resolveControlUiPluginAuthCookieGeneration,
} from "./http-auth-plugin-cookie.js";
import {
  authorizePluginGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
  setControlUiPluginAuthCookieForRequest,
} from "./http-auth-utils.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { makeMockHttpResponse } from "./test-http-response.js";
import { withTempConfig } from "./test-temp-config.js";

function issueCookie(
  profileId?: string,
  {
    pluginId = "example",
    generation = resolveControlUiPluginAuthCookieGeneration("generation", getRuntimeConfig()),
  }: { pluginId?: string; generation?: string } = {},
): string {
  const { res, setHeader } = makeMockHttpResponse();
  setControlUiPluginAuthCookie(
    res,
    [{ pluginId, path: "/plugins/example", match: "prefix", scopes: ["operator.read"] }],
    { generation, ...(profileId ? { profileId } : {}) },
  );
  const value = setHeader.mock.calls.at(-1)?.[1];
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string" || !header) {
    throw new Error("expected plugin auth cookie");
  }
  return header.split(";", 1)[0]!;
}

function authorizeCookie(cookie: string, authGeneration = "generation") {
  return authorizeControlUiPluginCookieRequest(
    { method: "GET", headers: { cookie } } as IncomingMessage,
    {
      requestPath: "/plugins/example/session",
      authGeneration,
    },
  );
}

async function withRoleConfig(run: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          roles: {
            default: "denied",
            definitions: {
              admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
              writer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
              denied: { sessions: { others: "none" }, agents: [], scopes: [] },
            },
          },
        },
      },
      run,
    });
  });
}

describe("Control UI plugin auth cookie profile binding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
  });

  it("prepares cold cookie profile facts and revalidates demotion without caller-thread SQL", async () => {
    await withRoleConfig(async () => {
      const profile = ensureProfileForEmail("cold-reader@example.test");
      setUserProfileRole(profile.id, "writer");
      const auth = {
        mode: "token",
        token: "synthetic-cookie-reader",
        allowTailscale: false,
      } as const;
      const cookie = issueCookie(profile.id, {
        generation: resolveControlUiPluginAuthCookieGeneration(
          resolveSharedGatewaySessionGeneration(auth),
          getRuntimeConfig(),
        ),
      });
      const { res } = makeMockHttpResponse();
      const sql = observeHostDataSql();
      try {
        const admitted = await authorizePluginGatewayHttpRequestOrReply({
          req: { method: "GET", headers: { cookie } } as IncomingMessage,
          res,
          auth,
          requestPath: "/plugins/example/session",
          resolveOperatorScopes: () => [],
        });
        expect(admitted?.requestAuth).toMatchObject({
          authenticatedUserProfile: { profileId: profile.id },
          controlUiPluginGrants: [{ scopes: ["operator.read"] }],
        });
        await expect(admitted?.requestAuth.revalidate?.()).resolves.toBeUndefined();
        expect(sql.queries).toEqual([]);
        await setCanonicalUserProfileRole(profile.id, "denied");
        sql.queries.length = 0;
        await expect(admitted?.requestAuth.revalidate?.()).rejects.toThrow("Unauthorized");
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        res.destroy();
        invalidateOperatorRolePolicy(profile.id);
      }
    });
  });

  it("uses an explicit owner credential independently of a revoked ambient visitor cookie", async () => {
    await withRoleConfig(async () => {
      const profile = ensureProfileForEmail("visitor@example.test");
      const { config, registry } = createPluginRegistryFixture();
      registerVirtualTestPlugin({
        registry,
        config,
        id: "person-access",
        name: "Person access",
        register(api) {
          api.registerGatewayAccessPolicy({
            authorize() {
              throw new Error("Visitor grant ended");
            },
          });
        },
      });
      setActivePluginRegistry(registry.registry);
      const auth = { mode: "token", token: "independent-owner", allowTailscale: false } as const;
      const cookie = issueCookie(profile.id, {
        generation: resolveControlUiPluginAuthCookieGeneration(
          resolveSharedGatewaySessionGeneration(auth),
          getRuntimeConfig(),
        ),
      });
      const catalog = await prepareUserProfileCatalog();
      try {
        for (const authorization of [undefined, "Bearer independent-owner"]) {
          const { res } = makeMockHttpResponse();
          const result = await authorizePluginGatewayHttpRequestOrReply({
            req: createGatewayRequest({
              path: "/plugins/example/session",
              headers: { cookie },
              authorization,
            }),
            res,
            auth,
            requestPath: "/plugins/example/session",
            resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes,
          });
          if (authorization) {
            expect(result?.requestAuth.operatorRoleActor).toEqual({ kind: "system" });
            expect(result?.operatorScopes).toContain("operator.admin");
            expect(res.writableEnded).toBe(false);
          } else {
            expect(result).toBeNull();
            expect(res.statusCode).toBe(403);
          }
          res.destroy();
        }
      } finally {
        catalog.release();
      }
    });
  });

  it("revokes issued Tailscale cookies on policy changes without rotating shared credentials", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await withTempConfig({
        cfg: { gateway: { auth: { allowTailscale: true } } },
        run: async () => {
          const registry = createEmptyPluginRegistry();
          registry.controlUiDescriptors.push({
            pluginId: "example",
            source: "example",
            descriptor: {
              id: "panel",
              surface: "tab",
              label: "Panel",
              path: "/plugins/example",
              requiredScopes: ["operator.admin"],
            },
          });
          registry.httpRoutes.push({
            pluginId: "example",
            source: "example",
            path: "/plugins/example",
            match: "prefix",
            auth: "gateway",
            handler: async () => true,
          });
          setActivePluginRegistry(registry);
          const auth = { mode: "token" as const, token: "shared-secret", allowTailscale: true };
          const generation = resolveSharedGatewaySessionGeneration(auth);
          const profile = ensureProfileForEmail("tailscale-reader@example.test");
          const issued = makeMockHttpResponse();
          expect(
            setControlUiPluginAuthCookieForRequest(
              { headers: {} } as IncomingMessage,
              issued.res,
              generation,
              getRuntimeConfig(),
              CLI_DEFAULT_OPERATOR_SCOPES,
              profile.id,
            ),
          ).toEqual([
            {
              pluginId: "example",
              path: "/plugins/example",
              match: "prefix",
              scopes: ["operator.read"],
            },
          ]);
          expect(issued.setHeader).toHaveBeenCalledWith(
            "Set-Cookie",
            expect.arrayContaining([expect.stringContaining("Path=/plugins/example")]),
          );
          const value = issued.setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
          const header = Array.isArray(value) ? value[0] : value;
          expect(typeof header).toBe("string");
          const request = { method: "GET", headers: { cookie: header } } as IncomingMessage;
          const authorize = async (allowTailscale: boolean) => {
            const response = makeMockHttpResponse();
            const result = await authorizePluginGatewayHttpRequestOrReply({
              req: request,
              res: response.res,
              auth: { ...auth, allowTailscale },
              cfg: getRuntimeConfig(),
              requestPath: "/plugins/example/view",
              resolveOperatorScopes: () => [],
            });
            return { result, response };
          };
          expect((await authorize(true)).result?.requestAuth.controlUiPluginGrants).toMatchObject([
            { pluginId: "example", scopes: ["operator.read"] },
          ]);
          setRuntimeConfigSnapshot({ ...getRuntimeConfig(), ui: { seamColor: "#334455" } });
          expect((await authorize(true)).result).not.toBeNull();

          setRuntimeConfigSnapshot({ gateway: { auth: { allowTailscale: false } } });
          expect(resolveSharedGatewaySessionGeneration({ ...auth, allowTailscale: false })).toBe(
            generation,
          );
          const revoked = await authorize(false);
          expect(revoked.result).toBeNull();
          expect(revoked.response.res.statusCode).toBe(401);
        },
      });
    });
  });

  it.each([{ trustedProxies: undefined }, { trustedProxies: ["192.0.2.1"] }])(
    "retains the signed viewer and proxy override with runtime proxies $trustedProxies",
    async ({ trustedProxies }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await withTempConfig({
          cfg: { gateway: { trustedProxies } },
          run: async () => {
            const profile = ensureProfileForEmail("plugin-reader@example.test");
            const catalog = await prepareUserProfileCatalog();
            onTestFinished(catalog.release);
            expect(authorizeCookie(issueCookie(profile.id))?.requestAuth).toMatchObject({
              authenticatedUserProfile: { profileId: profile.id },
              controlUiPluginGrants: [{ scopes: ["operator.read"] }],
            });
            expect(authorizeCookie(issueCookie("missing-profile"))).toBeNull();
            const auth = {
              mode: "trusted-proxy" as const,
              allowTailscale: false,
              trustedProxy: { userHeader: "x-user" },
            };
            const proxies = ["127.0.0.1"];
            const cookie = issueCookie(profile.id, {
              generation: resolveControlUiPluginAuthCookieGeneration(
                resolveSharedGatewaySessionGeneration(auth, proxies),
                getRuntimeConfig(),
              ),
            });
            const { res } = makeMockHttpResponse();
            try {
              const admitted = await authorizePluginGatewayHttpRequestOrReply({
                req: { method: "GET", headers: { cookie } } as IncomingMessage,
                res,
                auth,
                trustedProxies: proxies,
                requestPath: "/plugins/example/session",
                resolveOperatorScopes: () => [],
              });
              expect(admitted?.requestAuth.authenticatedUserProfile?.profileId).toBe(profile.id);
              expect(admitted?.requestAuth.hasCurrentClientAuthority?.()).toBe(true);
              await expect(admitted?.requestAuth.revalidate?.()).resolves.toBeUndefined();
              setRuntimeConfigSnapshot({ gateway: { trustedProxies: ["198.51.100.1"] } });
              expect(admitted?.requestAuth.hasCurrentClientAuthority?.()).toBe(false);
              await expect(admitted?.requestAuth.revalidate?.()).rejects.toThrow("Unauthorized");
            } finally {
              res.destroy();
            }
          },
        });
      });
    },
  );

  it.each([
    { name: "mixed profiles", profiles: ["first", "second"], response: "open" },
    { name: "mixed bound and unbound grants", profiles: ["first", undefined], response: "open" },
    { name: "an ended response", profiles: ["first"], response: "ended" },
    { name: "a destroyed response", profiles: ["first"], response: "destroyed" },
  ] as const)("avoids profile storage for $name", async ({ profiles, response }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const profileIds = profiles.map((profile) =>
        profile ? ensureProfileForEmail(`${profile}-cookie-reader@example.test`).id : undefined,
      );
      expect(isUserProfileCatalogReady()).toBe(false);
      const auth = {
        mode: "token",
        token: "synthetic-denial-token",
        allowTailscale: false,
      } as const;
      const generation = resolveControlUiPluginAuthCookieGeneration(
        resolveSharedGatewaySessionGeneration(auth),
        getRuntimeConfig(),
      );
      const cookie = profileIds
        .map((profile, index) =>
          issueCookie(profile, { pluginId: index ? "overlap" : "example", generation }),
        )
        .join("; ");
      const req = { method: "GET", headers: { cookie } } as IncomingMessage;
      expect(
        resolveControlUiPluginAuthCookieGrants(req, {
          requestPath: "/plugins/example/session",
          generation,
        }),
      ).toHaveLength(profiles.length);
      const { res } = makeMockHttpResponse();
      if (response !== "open") {
        res.statusCode = 204;
        if (response === "ended") {
          res.end();
        } else {
          res.destroy();
        }
      }
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const sql = observeHostDataSql();
      try {
        await expect(
          authorizePluginGatewayHttpRequestOrReply({
            req,
            res,
            auth,
            requestPath: "/plugins/example/session",
            resolveOperatorScopes: () => [],
          }),
        ).resolves.toBeNull();
        expect(res.statusCode).toBe(response === "open" ? 401 : 204);
        expect(sql.queries).toEqual([]);
        expect(reads).not.toHaveBeenCalled();
      } finally {
        sql.restore();
        reads.mockRestore();
        res.destroy();
      }
    });
  });

  it.each([
    {
      name: "retired generation",
      profiles: ["viewer"],
      roles: false,
      generation: "replacement-generation",
    },
    { name: "unbound role grant", profiles: [undefined], roles: true },
    { name: "missing durable profile", profiles: ["missing-profile"], roles: true },
  ])("rejects $name", async ({ profiles, roles, generation }) => {
    const run = async () => {
      const cookie = profiles
        .map((profile, index) => issueCookie(profile, { pluginId: index ? "overlap" : "example" }))
        .join("; ");
      expect(authorizeCookie(cookie, generation)).toBeNull();
    };
    if (roles) {
      await withRoleConfig(run);
    } else {
      await withTempConfig({ cfg: {}, run });
    }
  });

  it.each(["admin", "writer"])(
    "preserves a read grant under %s until the profile is demoted",
    async (role) => {
      await withRoleConfig(async () => {
        const profile = ensureProfileForEmail("plugin-reader@example.test");
        setUserProfileRole(profile.id, role);
        const cookie = issueCookie(profile.id);
        const catalog = await prepareUserProfileCatalog();
        try {
          expect(authorizeCookie(cookie)?.requestAuth).toMatchObject({
            authenticatedUserProfile: { profileId: profile.id },
            controlUiPluginGrants: [{ pluginId: "example", scopes: ["operator.read"] }],
          });
          setUserProfileRole(profile.id, "denied");
          invalidateOperatorRolePolicy(profile.id);
          expect(authorizeCookie(cookie)?.requestAuth.controlUiPluginGrants).toMatchObject([
            { pluginId: "example", scopes: [] },
          ]);
        } finally {
          catalog.release();
          invalidateOperatorRolePolicy(profile.id);
        }
      });
    },
  );

  it.each(["profile-guest", undefined])(
    "preserves the signed profile binding (%s)",
    async (profileId) => {
      const request = {
        headers: { cookie: issueCookie(profileId, { generation: "generation" }) },
      } as IncomingMessage;
      const grants = [
        {
          pluginId: "example",
          path: "/plugins/example",
          match: "prefix",
          scopes: ["operator.read"],
          ...(profileId ? { profileId } : {}),
        },
      ];
      expect(
        resolveControlUiPluginAuthCookieGrants(request, {
          requestPath: profileId ? "/plugins/example/session" : "/plugins/example",
          generation: "generation",
        }),
      ).toEqual(grants);
      if (!profileId) {
        await withTempConfig({
          cfg: {},
          run: async () => {
            expect(authorizeCookie(issueCookie())?.requestAuth.controlUiPluginGrants).toEqual(
              grants,
            );
          },
        });
      }
    },
  );
});
