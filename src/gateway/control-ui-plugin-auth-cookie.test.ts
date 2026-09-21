import type { IncomingMessage } from "node:http";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveControlUiPluginAuthCookieGrants,
  setControlUiPluginAuthCookie,
} from "./control-ui-plugin-auth-cookie.js";
import { createGatewayRequest } from "./hooks-test-helpers.js";
import { authorizeControlUiPluginCookieRequest } from "./http-auth-plugin-cookie.js";
import {
  authorizePluginGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { makeMockHttpResponse } from "./test-http-response.js";
import { withTempConfig } from "./test-temp-config.js";

function issueCookie(
  profileId?: string,
  {
    pluginId = "example",
    generation = "generation",
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
        generation: resolveSharedGatewaySessionGeneration(auth),
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

  it("retains the signed viewer without named roles and rejects an unavailable viewer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await withTempConfig({
        cfg: {},
        run: async () => {
          const profile = ensureProfileForEmail("plugin-reader@example.test");
          expect(authorizeCookie(issueCookie(profile.id))?.requestAuth).toMatchObject({
            authenticatedUserProfile: { profileId: profile.id },
            controlUiPluginGrants: [{ scopes: ["operator.read"] }],
          });
          expect(authorizeCookie(issueCookie("missing-profile"))).toBeNull();
        },
      });
    });
  });

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
      headers: { cookie: issueCookie("profile-guest") },
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
    const request = { headers: { cookie: issueCookie() } } as IncomingMessage;

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
