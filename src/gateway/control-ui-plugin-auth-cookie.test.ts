import { ServerResponse, type IncomingMessage } from "node:http";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
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
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { makeMockHttpResponse } from "./test-http-response.js";
import { withTempConfig } from "./test-temp-config.js";

const requestPath = "/plugins/example/session";
const cookieRoute = { pluginId: "example", path: "/plugins/example", match: "prefix" } as const;
const tokenAuth = (token: string, allowTailscale = false) =>
  ({ mode: "token", token, allowTailscale }) as const;
const cookieRequest = (cookie: string): IncomingMessage =>
  ({ method: "GET", headers: { cookie } }) as IncomingMessage;
type Admission = Parameters<typeof authorizePluginGatewayHttpRequestOrReply>[0];
const cookieGeneration = (auth: Admission["auth"], proxies?: string[]) =>
  resolveControlUiPluginAuthCookieGeneration(
    resolveSharedGatewaySessionGeneration(auth, proxies),
    getRuntimeConfig(),
  );
function admit(
  params: Omit<Admission, "requestPath" | "resolveOperatorScopes"> &
    Partial<Pick<Admission, "requestPath" | "resolveOperatorScopes">>,
) {
  return authorizePluginGatewayHttpRequestOrReply({
    requestPath,
    resolveOperatorScopes: () => [],
    ...params,
  });
}
function grants(req: IncomingMessage, generation: string | undefined, path = requestPath) {
  return resolveControlUiPluginAuthCookieGrants(req, { requestPath: path, generation });
}

function issueCookie(
  profileId?: string,
  {
    pluginId = "example",
    generation = resolveControlUiPluginAuthCookieGeneration("generation", getRuntimeConfig()),
    scopes = ["operator.read"],
    request,
  }: {
    pluginId?: string;
    generation?: string;
    scopes?: OperatorScope[];
    request?: IncomingMessage;
  } = {},
): string {
  const { res, setHeader } = makeMockHttpResponse();
  setControlUiPluginAuthCookie(res, [{ ...cookieRoute, pluginId, scopes }], {
    generation,
    ...(profileId ? { profileId } : {}),
    request,
  });
  const value = setHeader.mock.calls.at(-1)?.[1];
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string" || !header) {
    throw new Error("expected plugin auth cookie");
  }
  return header.split(";", 1)[0]!;
}

function authorizeCookie(cookie: string, authGeneration = "generation") {
  return authorizeControlUiPluginCookieRequest(cookieRequest(cookie), {
    requestPath,
    authGeneration,
  });
}

function withStateConfig(run: () => Promise<void>, cfg: unknown = {}) {
  return withOpenClawTestState({ scenario: "minimal" }, () => withTempConfig({ cfg, run }));
}

function withRoleConfig(run: () => Promise<void>) {
  return withStateConfig(run, {
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
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

it("caps a broader signed read cookie on remote native and panel reads without changing direct authority", async () => {
  await withTempConfig({
    cfg: {},
    run: async () => {
      const auth = tokenAuth("synthetic-cookie-ceiling");
      const generation = cookieGeneration(auth);
      const signedScopes: OperatorScope[] = [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.pairing",
        "operator.talk.secrets",
      ];
      for (const remote of [false, true]) {
        const req = createGatewayRequest({ path: requestPath, headers: {} });
        if (remote) {
          markGatewayIngressTransport(req, {
            kind: "remote-forwarded",
            context: createRemoteControlUiIngressTestContext({
              operatorScopeCeiling: ["operator.read"],
            }),
          });
        }
        const cookie = issueCookie(remote ? "gateway-owner" : undefined, {
          generation,
          scopes: signedScopes,
          request: req,
        });
        req.headers.cookie = cookie;
        if (remote) {
          for (const forwarded of [false, true]) {
            const other = createGatewayRequest({ path: requestPath, headers: { cookie } });
            if (forwarded) {
              markGatewayIngressTransport(other, {
                kind: "remote-forwarded",
                context: createRemoteControlUiIngressTestContext(),
              });
            }
            expect(grants(other, generation)).toEqual([]);
            other.destroy();
          }
        }
        const expected = remote ? ["operator.read"] : signedScopes;
        expect(grants(req, generation, remote ? requestPath : cookieRoute.path)).toEqual([
          { ...cookieRoute, scopes: expected, ...(remote ? { profileId: "gateway-owner" } : {}) },
        ]);
        const res = new ServerResponse(req);
        try {
          const admission = await admit({ req, res, auth });
          expect(admission?.requestAuth.controlUiPluginGrants?.[0]?.scopes).toEqual(expected);
          expect(admission?.requestAuth.revalidate).toBeTypeOf("function");
          await admission?.requestAuth.revalidate?.();
          expect(admission?.requestAuth.controlUiPluginGrants?.[0]?.scopes).toEqual(expected);
        } finally {
          res.destroy();
          req.destroy();
        }
      }
    },
  });
});

it.each(["admin", "writer"])(
  "prepares cold %s cookie facts and revalidates demotion without caller-thread SQL",
  async (role) => {
    await withRoleConfig(async () => {
      const profile = ensureProfileForEmail("cold-reader@example.test");
      setUserProfileRole(profile.id, role);
      const auth = tokenAuth("synthetic-cookie-reader");
      const cookie = issueCookie(profile.id, { generation: cookieGeneration(auth) });
      const { res } = makeMockHttpResponse();
      const sql = observeHostDataSql();
      try {
        const admitted = await admit({ req: cookieRequest(cookie), res, auth });
        expect(admitted?.requestAuth).toMatchObject({
          authenticatedUserProfile: { profileId: profile.id },
          controlUiPluginGrants: [{ pluginId: "example", scopes: ["operator.read"] }],
        });
        await expect(admitted?.requestAuth.revalidate?.()).resolves.toBeUndefined();
        expect(sql.queries).toEqual([]);
        await setCanonicalUserProfileRole(profile.id, "denied");
        sql.queries.length = 0;
        await expect(admitted?.requestAuth.revalidate?.()).rejects.toThrow("Unauthorized");
        expect(
          authorizeCookie(cookie, resolveSharedGatewaySessionGeneration(auth))?.requestAuth,
        ).toMatchObject({
          authenticatedUserProfile: { profileId: profile.id },
          controlUiPluginGrants: [{ pluginId: "example", scopes: [] }],
        });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        res.destroy();
        invalidateOperatorRolePolicy(profile.id);
      }
    });
  },
);

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
    const auth = tokenAuth("independent-owner");
    const cookie = issueCookie(profile.id, { generation: cookieGeneration(auth) });
    const catalog = await prepareUserProfileCatalog();
    try {
      for (const authorization of [undefined, "Bearer independent-owner"]) {
        const { res } = makeMockHttpResponse();
        const result = await admit({
          req: createGatewayRequest({ path: requestPath, headers: { cookie }, authorization }),
          res,
          auth,
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
  await withStateConfig(
    async () => {
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
        ...cookieRoute,
        source: "example",
        auth: "gateway",
        handler: async () => true,
      });
      setActivePluginRegistry(registry);
      const auth = tokenAuth("shared-secret", true);
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
      ).toEqual([{ ...cookieRoute, scopes: ["operator.read"] }]);
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
        const result = await admit({
          req: request,
          res: response.res,
          auth: { ...auth, allowTailscale },
          cfg: getRuntimeConfig(),
          requestPath: "/plugins/example/view",
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
    { gateway: { auth: { allowTailscale: true } } },
  );
});

it.each([{ trustedProxies: undefined }, { trustedProxies: ["192.0.2.1"] }])(
  "retains the signed viewer and proxy override with runtime proxies $trustedProxies",
  async ({ trustedProxies }) => {
    await withStateConfig(
      async () => {
        const profile = ensureProfileForEmail("plugin-reader@example.test");
        const catalog = await prepareUserProfileCatalog();
        onTestFinished(catalog.release);
        const signed = authorizeCookie(issueCookie(profile.id))?.requestAuth;
        expect(signed?.authenticatedUserProfile?.profileId).toBe(profile.id);
        expect(signed?.controlUiPluginGrants).toEqual([
          { ...cookieRoute, scopes: ["operator.read"], profileId: profile.id },
        ]);
        expect(authorizeCookie(issueCookie("missing-profile"))).toBeNull();
        const auth = {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: { userHeader: "x-user" },
        } as const;
        const proxies = ["127.0.0.1"];
        const cookie = issueCookie(profile.id, { generation: cookieGeneration(auth, proxies) });
        const { res } = makeMockHttpResponse();
        try {
          const admitted = await admit({
            req: cookieRequest(cookie),
            res,
            auth,
            trustedProxies: proxies,
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
      { gateway: { trustedProxies } },
    );
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
    const auth = tokenAuth("synthetic-denial-token");
    const generation = cookieGeneration(auth);
    const cookie = profileIds
      .map((profile, index) =>
        issueCookie(profile, { pluginId: index ? "overlap" : "example", generation }),
      )
      .join("; ");
    const req = cookieRequest(cookie);
    expect(grants(req, generation)).toHaveLength(profiles.length);
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
      await expect(admit({ req, res, auth })).resolves.toBeNull();
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

it("rejects an unbound role grant", async () => {
  await withRoleConfig(async () => {
    expect(authorizeCookie(issueCookie())).toBeNull();
  });
});
