import type { IncomingMessage } from "node:http";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
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

function authorizeCookie(cookie: string) {
  return authorizeControlUiPluginCookieRequest(
    { method: "GET", headers: { cookie } } as IncomingMessage,
    {
      requestPath: "/plugins/example/session",
      authGeneration: "generation",
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
  afterEach(() => resetPluginRuntimeStateForTest());

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
            descriptor: { id: "panel", surface: "tab", label: "Panel", path: "/plugins/example" },
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
          setControlUiPluginAuthCookieForRequest(
            { headers: {} } as IncomingMessage,
            issued.res,
            "tailscale",
            true,
            generation,
            getRuntimeConfig(),
            undefined,
            profile.id,
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

  it("issues read-only plugin frame grants for Tailscale-authenticated bootstrap", () => {
    const registry = createEmptyPluginRegistry();
    registry.controlUiDescriptors.push({
      pluginId: "demo-plugin",
      source: "demo-plugin",
      descriptor: {
        surface: "tab",
        id: "demo",
        label: "Demo",
        path: "/secure-hook/panel",
        requiredScopes: ["operator.admin"],
      },
    });
    registry.httpRoutes.push({
      pluginId: "demo-plugin",
      source: "demo-plugin",
      path: "/secure-hook",
      auth: "gateway",
      match: "prefix",
      handler: async () => true,
    });
    setActivePluginRegistry(registry);
    const { res, setHeader } = makeMockHttpResponse();

    expect(
      setControlUiPluginAuthCookieForRequest(
        { headers: {} } as IncomingMessage,
        res,
        "tailscale",
        true,
        "test-generation",
        {},
      ),
    ).toEqual([
      {
        pluginId: "demo-plugin",
        path: "/secure-hook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    expect(setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.arrayContaining([expect.stringContaining("Path=/secure-hook")]),
    );
  });

  it.each([{ trustedProxies: undefined }, { trustedProxies: ["192.0.2.1"] }])(
    "retains the signed viewer and proxy override with runtime proxies $trustedProxies",
    async ({ trustedProxies }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await withTempConfig({
          cfg: { gateway: { trustedProxies } },
          run: async () => {
            const profile = ensureProfileForEmail("plugin-reader@example.test");
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

  it.each(["another-profile", undefined])(
    "rejects mixed signed viewer grants (%s) without roles",
    async (otherProfileId) => {
      await withTempConfig({
        cfg: {},
        run: async () => {
          const cookie = `${issueCookie("viewer")}; ${issueCookie(otherProfileId, { pluginId: "overlap" })}`;
          expect(authorizeCookie(cookie)).toBeNull();
        },
      });
    },
  );

  it("invalidates a signed viewer grant when the Gateway auth generation changes", () => {
    const req = { method: "GET", headers: { cookie: issueCookie("viewer") } } as IncomingMessage;
    expect(
      authorizeControlUiPluginCookieRequest(req, {
        requestPath: "/plugins/example/session",
        authGeneration: "replacement-generation",
      }),
    ).toBeNull();
  });

  it.each(["admin", "writer"])(
    "preserves a read grant under %s until the profile is demoted",
    async (role) => {
      await withRoleConfig(async () => {
        const profile = ensureProfileForEmail("plugin-reader@example.test");
        setUserProfileRole(profile.id, role);
        const cookie = issueCookie(profile.id);
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
          invalidateOperatorRolePolicy(profile.id);
        }
      });
    },
  );

  it.each([undefined, "missing-profile"])(
    "rejects a signed grant without a current durable profile (%s)",
    async (profileId) => {
      await withRoleConfig(async () => {
        expect(authorizeCookie(issueCookie(profileId))).toBeNull();
      });
    },
  );

  it("preserves the authenticated durable profile inside the signed grant", () => {
    const request = {
      headers: { cookie: issueCookie("profile-guest", { generation: "generation" }) },
    } as IncomingMessage;

    expect(
      resolveControlUiPluginAuthCookieGrants(request, {
        requestPath: "/plugins/example/session",
        generation: "generation",
      }),
    ).toEqual([
      {
        pluginId: "example",
        path: "/plugins/example",
        match: "prefix",
        scopes: ["operator.read"],
        profileId: "profile-guest",
      },
    ]);
  });

  it("keeps legacy grants unchanged when no profile is bound", async () => {
    const request = {
      headers: { cookie: issueCookie(undefined, { generation: "generation" }) },
    } as IncomingMessage;

    expect(
      resolveControlUiPluginAuthCookieGrants(request, {
        requestPath: "/plugins/example",
        generation: "generation",
      }),
    ).toEqual([
      {
        pluginId: "example",
        path: "/plugins/example",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    await withTempConfig({
      cfg: {},
      run: async () => {
        expect(authorizeCookie(issueCookie())?.requestAuth.controlUiPluginGrants).toEqual([
          {
            pluginId: "example",
            path: "/plugins/example",
            match: "prefix",
            scopes: ["operator.read"],
          },
        ]);
      },
    });
  });
});
