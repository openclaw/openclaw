import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  buildGatewayConnectAuth,
  selectGatewayConnectAuth,
} from "../../packages/gateway-client/src/connect-auth.js";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersListModelAccountsResult,
  type UsersSelectModelAccountResult,
  type UsersSelfResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { loadOriginDeviceToken } from "../infra/device-auth-store.js";
import { seedOriginDeviceToken } from "../infra/device-auth-store.test-support.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import {
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { OperatorScope } from "./operator-scopes.js";
import type { GatewayServer } from "./server-public.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  NODE_CLIENT,
  openTailscaleWs,
  openWs,
  rpcReq,
  testState,
  testTailscaleWhois,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { getTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "admin@example.com",
};
const NARROW_SCOPES = ["operator.read", "operator.write", "operator.talk"];
const UPGRADE_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];

function deviceIdentityPath(label: string): string {
  return path.join(tempDirs.make("openclaw-identity-scopes-"), `${label}.sqlite`);
}

function proxyAuth(identityScopes?: GatewayAuthConfig["identityScopes"]): GatewayAuthConfig {
  return {
    mode: "trusted-proxy",
    identityScopes,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
}

async function configureGatewayAuth(
  auth: GatewayAuthConfig,
  options?: { tailscaleMode?: "serve"; roles?: GatewayOperatorRolesConfig },
): Promise<void> {
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      ...(options?.tailscaleMode ? { tailscale: { mode: options.tailscaleMode } } : {}),
      ...(options?.roles ? { roles: options.roles } : {}),
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

function responseAuth(
  response: Awaited<ReturnType<typeof connectReq>>,
): HelloOk["auth"] | undefined {
  return (response.payload as HelloOk | undefined)?.auth;
}

function connectIdentity(
  ws: Awaited<ReturnType<typeof openWs>>,
  options: NonNullable<Parameters<typeof connectReq>[1]>,
) {
  return connectReq(ws, {
    prePairDevice: true,
    client: CONTROL_UI_CLIENT,
    browserOrigin: BROWSER_ORIGIN,
    ...options,
  });
}

async function withVerifiedIdentity(
  run: (
    ws: Awaited<ReturnType<typeof openWs>>,
    connected: Awaited<ReturnType<typeof connectReq>>,
  ) => Promise<void>,
  options: NonNullable<Parameters<typeof connectReq>[1]> = {},
  headers: Parameters<typeof openWs>[1] = TRUSTED_PROXY_HEADERS,
) {
  await withGatewayServer(async ({ port }) => {
    const ws = await openWs(port, headers);
    try {
      await run(
        ws,
        await connectIdentity(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.read"],
          deviceIdentityPath: deviceIdentityPath("identity-scope"),
          ...options,
        }),
      );
    } finally {
      ws.close();
    }
  });
}

const GITHUB_RATE_LIMITED_ERROR = {
  code: "UNAVAILABLE",
  message: expect.stringContaining("GitHub is rate limiting profile verification"),
  retryAfterMs: expect.toSatisfy((ms: number) => ms > 60_000),
};

/** Stubs only api.github.com user lookups; `quotaExhausted` switches to GitHub's real 403. */
function stubGitHubUserLookups(users: Record<string, { id: number; login: string }>) {
  const realFetch = globalThis.fetch;
  const github = { requests: [] as string[], quotaExhausted: false };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.github.com") {
      return await realFetch(input, init);
    }
    github.requests.push(url.pathname);
    if (github.quotaExhausted) {
      return new Response("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1_000) + 3_600),
        },
      });
    }
    const user = users[url.pathname.replace(/^\/users\//, "")];
    return user ? Response.json(user) : Response.json({}, { status: 404 });
  });
  onTestFinished(() => fetchSpy.mockRestore());
  return github;
}

/** Connects as `<login>@github` through the managed Tailscale Serve listener. */
function gitHubTailscalePeople(
  server: Pick<GatewayServer, "getTailscaleIngressEndpoint">,
  scopes = ["operator.read"],
) {
  const endpoint = server.getTailscaleIngressEndpoint();
  if (!endpoint) {
    throw new Error("expected managed Tailscale listener");
  }
  // The GitHub API transport is the GitHub plugin's public surface; load it lazily from source.
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  return async (
    login: string,
    run: (ws: WebSocket, connected: Awaited<ReturnType<typeof connectReq>>) => Promise<void>,
  ) => {
    testTailscaleWhois.value = { login, name: login };
    const ws = await openTailscaleWs(endpoint, {
      origin: BROWSER_ORIGIN,
      "tailscale-user-login": login,
    });
    try {
      await run(
        ws,
        await connectIdentity(ws, {
          skipDefaultAuth: true,
          scopes,
          deviceIdentityPath: deviceIdentityPath(`github-${login}`),
        }),
      );
    } finally {
      ws.close();
    }
  };
}

describe("gateway identity scope grants", () => {
  test("denies missing person access, retires grant or alias authority, and preserves staff", async () => {
    await configureGatewayAuth(proxyAuth(), {
      roles: {
        default: "reader",
        definitions: {
          reader: {
            accessPolicyPlugin: "person-access",
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.read"],
          },
          staff: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
        },
      },
    });
    setUserProfileRole(ensureProfileForEmail("staff@example.com").id, "staff");
    const { config, registry } = createPluginRegistryFixture();
    let grant: AbortController | undefined;
    registerVirtualTestPlugin({
      registry,
      config,
      id: "person-access",
      name: "Person access",
      register(api) {
        api.registerGatewayAccessPolicy({
          authorize({ profile }) {
            if (profile.assignedRole === "staff") {
              return undefined;
            }
            const current = grant;
            if (!current) {
              throw new Error("An active grant is required");
            }
            return { signal: current.signal, assertCurrent: () => current.signal.throwIfAborted() };
          },
        });
      },
    });
    setTestPluginRegistry(registry.registry);
    await withGatewayServer(async ({ port }) => {
      const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
      const connect = async (label: string, email: string) => {
        const socket = await openWs(port, { ...TRUSTED_PROXY_HEADERS, "x-forwarded-user": email });
        sockets.push(socket);
        const result = await connectIdentity(socket, {
          skipDefaultAuth: true,
          scopes: ["operator.read"],
          deviceIdentityPath: deviceIdentityPath(`person-access-${label}`),
        });
        return { socket, result };
      };
      const accessPolicies = getTestPluginRegistry().gatewayAccessPolicies;
      const registeredPolicies = [...accessPolicies];
      try {
        grant = new AbortController();
        accessPolicies.length = 0;
        expect((await connect("unavailable", "visitor@example.com")).result).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN", details: { code: "OPERATOR_ACCESS_DENIED" } },
        });
        const staff = await connect("staff", "staff@example.com");
        expect(staff.result.ok).toBe(true);
        accessPolicies.push(...registeredPolicies);
        grant = undefined;
        expect((await connect("missing", "visitor@example.com")).result).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN", details: { code: "OPERATOR_ACCESS_DENIED" } },
        });
        grant = new AbortController();
        const guest = await connect("guest", "visitor@example.com");
        expect(guest.result.ok).toBe(true);
        expect((await rpcReq(guest.socket, "status")).ok).toBe(true);
        grant.abort(new Error("Grant expired"));
        expect(await waitForWsClose(guest.socket, 1_000)).toBe(true);
        expect((await rpcReq(staff.socket, "status")).ok).toBe(true);
        expect((await connect("ended", "visitor@example.com")).result.ok).toBe(false);

        grant = new AbortController();
        const person = ensureProfileForEmail("visitor@example.com");
        linkEmail("retained@example.com", person.id);
        const replacement = ensureProfileForEmail("replacement@example.com");
        const aliasGuest = await connect("alias-guest", "visitor@example.com");
        expect(aliasGuest.result.ok).toBe(true);
        setDisplayName(person.id, "Updated visitor");
        linkEmail("added@example.com", person.id);
        expect((await rpcReq(aliasGuest.socket, "status")).ok).toBe(true);

        const closed = waitForWsClose(aliasGuest.socket, 1_000);
        linkEmail("visitor@example.com", replacement.id);
        linkEmail("visitor@example.com", person.id);
        expect(await closed).toBe(true);
        expect(grant.signal.aborted).toBe(false);
        expect((await rpcReq(staff.socket, "status")).ok).toBe(true);
        expect((await connect("restored", "visitor@example.com")).result.ok).toBe(true);
      } finally {
        accessPolicies.splice(0, accessPolicies.length, ...registeredPolicies);
        for (const socket of sockets) {
          socket.close();
        }
      }
    });
  });

  test.each([
    {
      label: "unassigned default guest",
      assignedRole: undefined,
      expectedScopes: ["operator.read", "operator.write"],
    },
    {
      label: "admin-only without identity grants",
      assignedRole: "admin-only",
      identityScopes: [],
      deviceScopes: NARROW_SCOPES,
      expectedScopes: NARROW_SCOPES,
    },
    {
      label: "read-only from an admin-only identity grant",
      assignedRole: "read-only",
      identityScopes: ["operator.admin"] satisfies OperatorScope[],
      deviceScopes: [],
      expectedScopes: ["operator.read"],
    },
    {
      label: "empty",
      assignedRole: "denied",
      deviceScopes: NARROW_SCOPES,
      expectedScopes: [],
    },
  ])("applies the $label role ceiling after device and identity grants", async (scenario) => {
    const identityScopes: OperatorScope[] = scenario.identityScopes ?? ["operator.admin"];
    await configureGatewayAuth(proxyAuth({ "admin@example.com": identityScopes }), {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          "admin-only": {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.admin"],
          },
          "read-only": {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.read"],
          },
          denied: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    });
    const profile = ensureProfileForEmail("admin@example.com");
    if (scenario.assignedRole) {
      setUserProfileRole(profile.id, scenario.assignedRole);
    }

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const connected = await connectIdentity(ws, {
          skipDefaultAuth: true,
          scopes: scenario.deviceScopes ?? ["operator.read", "operator.write"],
          deviceIdentityPath: deviceIdentityPath(`identity-role-${scenario.label}`),
        });
        expect(connected.ok).toBe(true);
        expect((await rpcReq(ws, "status")).ok).toBe(scenario.expectedScopes.length > 0);
        expect(responseAuth(connected)?.scopes).toEqual(scenario.expectedScopes);
        if (scenario.assignedRole === "read-only") {
          expect(
            await rpcReq(ws, "sessions.patch", { key: "agent:main:denied", label: "denied" }),
          ).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining("operator.write") },
          });
        }
        expect(responseAuth(connected)?.deviceToken).toBe(undefined);
        expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(false);
        if (!scenario.assignedRole) {
          const upgrade = await rpcReq(ws, "device.scopes.requestUpgrade", {
            scopes: ["operator.read", "operator.write", "operator.admin"],
          });
          expect(upgrade).toMatchObject({
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: expect.stringContaining("assigned operator role"),
            },
          });
        }
        if (scenario.assignedRole === "admin-only") {
          const admin = await openWs(port, TRUSTED_PROXY_HEADERS);
          try {
            const adminConnected = await connectIdentity(admin, {
              skipDefaultAuth: true,
              scopes: ["operator.admin"],
              deviceIdentityPath: deviceIdentityPath("scope-upgrade-approver"),
            });
            expect(adminConnected.ok).toBe(true);
            expect(responseAuth(adminConnected)?.deviceToken).toBeUndefined();
            const registration = await rpcReq<{ requestId: string }>(
              ws,
              "device.scopes.requestUpgrade",
              {
                scopes: UPGRADE_SCOPES,
              },
            );
            expect(registration.ok).toBe(true);
            const requestId = registration.payload?.requestId;
            expect(requestId).toBeTypeOf("string");
            expect((await rpcReq(admin, "device.pair.approve", { requestId })).ok).toBe(true);
            const result = await rpcReq<{ status: string; scopes: string[]; deviceToken: string }>(
              ws,
              "device.scopes.waitUpgrade",
              { requestId },
            );
            expect(result).toMatchObject({
              ok: true,
              payload: {
                status: "approved",
                scopes: [...UPGRADE_SCOPES, "operator.talk"].toSorted(),
              },
            });
            expect(result.payload?.deviceToken).toBeTypeOf("string");
            expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(false);
          } finally {
            admin.close();
          }
        }
      } finally {
        ws.close();
        invalidateOperatorRolePolicy(profile.id);
      }
    });
  });

  test("lets the shared-token owner manage accounts across device-token reconnects", async () => {
    const auth = { mode: "token", token: "secret" } satisfies GatewayAuthConfig;
    await configureGatewayAuth(auth);
    const identityPath = deviceIdentityPath(`model-account-owner-${auth.mode}`);
    await withGatewayServer(async ({ port }) => {
      let deviceToken: string | undefined;
      let authProfileId: string | undefined;
      for (const reconnect of [false, true]) {
        const ws = await openWs(port, { origin: BROWSER_ORIGIN });
        try {
          const connected = await connectIdentity(ws, {
            ...(reconnect ? { skipDefaultAuth: true, deviceToken } : {}),
            prePairDevice: !reconnect,
            scopes: ["operator.read", "operator.write"],
            deviceIdentityPath: identityPath,
          });
          expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
          const self = await rpcReq<UsersSelfResult>(ws, "users.self");
          expect(self, JSON.stringify(self.error)).toMatchObject({
            ok: true,
            payload: { profile: { id: GATEWAY_OWNER_PROFILE_ID } },
          });
          if (!reconnect) {
            deviceToken = (connected.payload as HelloOk).auth.deviceToken;
            expect(deviceToken).toBeTypeOf("string");
            authProfileId = connectUserModelAccount({
              ownerProfileId: GATEWAY_OWNER_PROFILE_ID,
              credential: { type: "api_key", provider: "anthropic", key: "synthetic-owner-key" },
              assertCurrent() {},
            }).authProfileId;
          }
          const cleared = await rpcReq(ws, "users.unlinkAuthProfile", {
            profileId: GATEWAY_OWNER_PROFILE_ID,
            provider: "anthropic",
          });
          expect(cleared.ok, JSON.stringify(cleared.error)).toBe(true);
          const inventory = await rpcReq<UsersListModelAccountsResult>(
            ws,
            "users.listModelAccounts",
          );
          expect(inventory, JSON.stringify(inventory.error)).toMatchObject({
            ok: true,
            payload: {
              profileId: GATEWAY_OWNER_PROFILE_ID,
              accounts: [{ authProfileId, provider: "anthropic", selected: false }],
              links: [],
            },
          });
          const selected = await rpcReq<UsersSelectModelAccountResult>(
            ws,
            "users.selectModelAccount",
            {
              authProfileId,
            },
          );
          expect(selected, JSON.stringify(selected.error)).toMatchObject({
            ok: true,
            payload: { links: [{ authProfileId, provider: "anthropic" }] },
          });
          const after = await rpcReq<UsersListModelAccountsResult>(ws, "users.listModelAccounts");
          expect(after.payload?.accounts).toEqual([
            expect.objectContaining({ authProfileId, selected: true }),
          ]);
        } finally {
          ws.close();
          expect(await waitForWsClose(ws, 1_000)).toBe(true);
        }
      }
    });
  });

  test("does not cap shared-secret clients without a durable profile", async () => {
    await configureGatewayAuth(
      { mode: "token", token: "secret" },
      {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              sessions: { others: "none" },
              agents: [],
              scopes: ["operator.read"],
            },
          },
        },
      },
    );

    await withGatewayServer(async ({ port }) => {
      const identityPath = deviceIdentityPath("identity-role-shared-secret");
      const ws = await openWs(port, { origin: BROWSER_ORIGIN });
      try {
        const connected = await connectIdentity(ws, {
          token: "secret",
          scopes: ["operator.read", "operator.write"],
          deviceIdentityPath: identityPath,
        });
        expect(connected.ok).toBe(true);
        expect(responseAuth(connected)?.scopes).toEqual(["operator.read", "operator.write"]);
        const deviceToken = responseAuth(connected)?.deviceToken;
        expect(deviceToken).toBeTypeOf("string");

        const unboundDevice = await openWs(port, { origin: BROWSER_ORIGIN });
        try {
          const rejected = await connectIdentity(unboundDevice, {
            skipDefaultAuth: true,
            prePairDevice: false,
            deviceToken,
            scopes: ["operator.read", "operator.write"],
            deviceIdentityPath: identityPath,
          });
          expect(rejected.ok).toBe(false);
          expect(rejected.error?.message).toContain("verified user identity");
        } finally {
          unboundDevice.close();
        }
      } finally {
        ws.close();
      }
    });
  });

  test("adds a case-insensitive trusted-proxy email grant without changing pairing", async () => {
    await configureGatewayAuth(proxyAuth({ "admin@example.com": ["operator.admin"] }));
    const identityPath = deviceIdentityPath("identity-scope-device");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });
    const configuredWorkspace = tempDirs.make("openclaw-identity-workspace-");
    const outsideWorkspace = tempDirs.make("openclaw-identity-outside-");
    testState.agentConfig = { workspace: configuredWorkspace };

    try {
      await withVerifiedIdentity(
        async (ws, connected) => {
          expect(connected.ok).toBe(true);
          expect(responseAuth(connected)?.scopes).toEqual(["operator.write", "operator.admin"]);
          expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(true);
          const browse = await rpcReq<{ path?: string }>(ws, "fs.listDir", {
            path: outsideWorkspace,
          });
          expect(browse.ok, JSON.stringify(browse.error)).toBe(true);
          expect(browse.payload?.path).toBe(outsideWorkspace);
        },
        { scopes: ["operator.write"], deviceIdentityPath: identityPath },
        {
          ...TRUSTED_PROXY_HEADERS,
          "x-forwarded-user": "Admin@Example.com",
        },
      );
    } finally {
      testState.agentConfig = undefined;
    }

    expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual(["operator.write"]);
    expect(
      (await listDevicePairing()).pending.filter((entry) => entry.deviceId === identity.deviceId),
    ).toEqual([]);
  });

  test("applies a trusted-proxy grant after clearing device-less declared scopes", async () => {
    await configureGatewayAuth(proxyAuth({ "admin@example.com": ["operator.admin"] }));

    await withVerifiedIdentity(
      async (_ws, connected) => {
        expect(connected.ok).toBe(true);
        expect(responseAuth(connected)?.scopes).toEqual(["operator.admin"]);
      },
      { device: null },
    );
  });

  test.each([
    { configuredIdentity: "peter", verifiedIdentity: "peter", expectedAdmin: true },
    { configuredIdentity: "Peter", verifiedIdentity: "peter", expectedAdmin: false },
  ])(
    "matches a verified Tailscale identity exactly ($configuredIdentity)",
    async ({ configuredIdentity, verifiedIdentity, expectedAdmin }) => {
      await configureGatewayAuth(
        {
          mode: "token",
          token: "secret",
          allowTailscale: true,
          identityScopes: { [configuredIdentity]: ["operator.admin"] },
        },
        { tailscaleMode: "serve" },
      );
      testTailscaleWhois.value = { login: verifiedIdentity, name: "Peter" };

      await withGatewayServer(async ({ server }) => {
        const endpoint = server.getTailscaleIngressEndpoint();
        if (!endpoint) {
          throw new Error("expected managed Tailscale listener");
        }
        const ws = await openTailscaleWs(endpoint, {
          origin: BROWSER_ORIGIN,
          "tailscale-user-login": verifiedIdentity,
        });
        try {
          const connected = await connectIdentity(ws, {
            skipDefaultAuth: true,
            scopes: ["operator.read"],
            deviceIdentityPath: deviceIdentityPath("identity-scope-tailscale"),
          });
          expect(connected.ok).toBe(true);
          expect(responseAuth(connected)?.scopes).toEqual(
            expectedAdmin ? ["operator.read", "operator.admin"] : ["operator.read"],
          );
        } finally {
          ws.close();
        }
      });
    },
  );

  test.each([
    {
      authentication: "verified person with cached device auth",
      token: undefined,
      usesTailscaleIdentity: true,
    },
    {
      authentication: "explicit shared-token authority",
      token: "secret",
      usesTailscaleIdentity: false,
    },
  ])("preserves $authentication on a second Tailscale connection", async (scenario) => {
    await configureGatewayAuth(
      { mode: "token", token: "secret", allowTailscale: true },
      { tailscaleMode: "serve" },
    );
    const login = "cached-person@example.com";
    testTailscaleWhois.value = { login, name: "Cached Person" };
    const identityPath = deviceIdentityPath("identity-tailscale-reconnect");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ server }) => {
      const endpoint = server.getTailscaleIngressEndpoint();
      if (!endpoint) {
        throw new Error("expected managed Tailscale listener");
      }
      const cacheKey = {
        gatewayScope: `ws://${endpoint.host}:${endpoint.port}`,
        deviceId: identity.deviceId,
        role: "operator",
      };
      const headers = { origin: BROWSER_ORIGIN, "tailscale-user-login": login };
      const initialWs = await openTailscaleWs(endpoint, headers);
      let profileId: string | undefined;
      try {
        const connected = await connectIdentity(initialWs, {
          skipDefaultAuth: true,
          scopes: ["operator.read", "operator.write"],
          deviceIdentityPath: identityPath,
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        const self = await rpcReq<UsersSelfResult>(initialWs, "users.self");
        expect(self.ok, JSON.stringify(self.error)).toBe(true);
        profileId = self.payload?.profile.id;
        expect(profileId).toBeTypeOf("string");
        expect(profileId).not.toBe(GATEWAY_OWNER_PROFILE_ID);
        const auth = (connected.payload as HelloOk).auth;
        if (!auth.deviceToken) {
          throw new Error("expected a Gateway-issued device token");
        }
        seedOriginDeviceToken({ ...cacheKey, token: auth.deviceToken, scopes: auth.scopes });
      } finally {
        initialWs.close();
        expect(await waitForWsClose(initialWs, 1_000)).toBe(true);
      }

      const cached = await loadOriginDeviceToken(cacheKey);
      if (!cached) {
        throw new Error("expected the first connection's cached device token");
      }
      const auth = buildGatewayConnectAuth(
        selectGatewayConnectAuth({
          token: scenario.token,
          storedToken: cached.token,
          storedScopes: cached.scopes,
        }),
      );
      const reconnectWs = await openTailscaleWs(endpoint, headers);
      try {
        const connected = await connectIdentity(reconnectWs, {
          ...auth,
          skipDefaultAuth: true,
          prePairDevice: false,
          scopes: ["operator.read", "operator.write"],
          deviceIdentityPath: identityPath,
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        const self = await rpcReq<UsersSelfResult>(reconnectWs, "users.self");
        expect(self, JSON.stringify(self.error)).toMatchObject({
          ok: true,
          payload: {
            profile: {
              id: scenario.usesTailscaleIdentity ? profileId : GATEWAY_OWNER_PROFILE_ID,
            },
          },
        });
      } finally {
        reconnectWs.close();
        expect(await waitForWsClose(reconnectWs, 1_000)).toBe(true);
      }
    });
  });

  test("keeps a verified GitHub person signed in while anonymous GitHub quota is exhausted", async () => {
    await configureGatewayAuth(
      { mode: "token", token: "secret", allowTailscale: true },
      { tailscaleMode: "serve" },
    );
    const github = stubGitHubUserLookups({ ada: { id: 583231, login: "ada" } });

    await withGatewayServer(async ({ server }) => {
      const withPerson = gitHubTailscalePeople(server);
      let profileId: string | undefined;
      await withPerson("ada@github", async (ws, connected) => {
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        const self = await rpcReq<UsersSelfResult>(ws, "users.self");
        expect(self.ok, JSON.stringify(self.error)).toBe(true);
        profileId = self.payload?.profile.id;
      });

      github.quotaExhausted = true;
      await withPerson("ada@github", async (ws, connected) => {
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        const self = await rpcReq<UsersSelfResult>(ws, "users.self");
        expect(self.payload?.profile.id, JSON.stringify(self.error)).toBe(profileId);
        const sessions = await rpcReq(ws, "sessions.list");
        expect(sessions.ok, JSON.stringify(sessions.error)).toBe(true);
      });
      await withPerson("eve@github", async (ws, connected) => {
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        for (const method of ["users.self", "sessions.list"]) {
          const response = await rpcReq(ws, method);
          expect(response.error, method).toMatchObject(GITHUB_RATE_LIMITED_ERROR);
        }
      });
    });
    expect(github.requests).toEqual(["/users/ada", "/users/ada"]);
  });

  test("refuses a reassigned GitHub login's former profile and role while GitHub is rate limiting", async () => {
    await configureGatewayAuth(
      { mode: "token", token: "secret", allowTailscale: true },
      {
        tailscaleMode: "serve",
        roles: {
          default: "guest",
          definitions: {
            guest: { sessions: { others: "none" }, agents: [], scopes: ["operator.read"] },
            staff: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    );
    const users = {
      ada: { id: 583231, login: "ada" },
      grace: { id: 1001, login: "grace" },
    } as Record<string, { id: number; login: string }>;
    const github = stubGitHubUserLookups(users);
    const scopes = ["operator.read", "operator.write"];
    const staffProfileIds: string[] = [];

    await withGatewayServer(async ({ server }) => {
      const withPerson = gitHubTailscalePeople(server, scopes);
      const profileOf = async (login: string) => {
        let profileId: string | undefined;
        await withPerson(login, async (ws, connected) => {
          expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
          const self = await rpcReq<UsersSelfResult>(ws, "users.self");
          expect(self.ok, JSON.stringify(self.error)).toBe(true);
          profileId = self.payload?.profile.id;
        });
        if (!profileId) {
          throw new Error(`expected a verified profile for ${login}`);
        }
        return profileId;
      };
      try {
        const ada = await profileOf("ada@github");
        const grace = await profileOf("grace@github");
        for (const profileId of [ada, grace]) {
          setUserProfileRole(profileId, "staff");
          staffProfileIds.push(profileId);
        }

        // ada renames to ada-lovelace, so the profile no longer holds the `ada` login.
        users["ada-lovelace"] = { id: 583231, login: "ada-lovelace" };
        expect(await profileOf("ada-lovelace@github")).toBe(ada);
        // The `grace` login moves to a different GitHub account id.
        users.grace = { id: 2002, login: "grace" };
        const graceSuccessor = await profileOf("grace@github");
        expect(graceSuccessor).not.toBe(grace);

        github.quotaExhausted = true;
        await withPerson("ada-lovelace@github", async (ws, connected) => {
          expect(responseAuth(connected)?.scopes).toEqual(scopes);
          const self = await rpcReq<UsersSelfResult>(ws, "users.self");
          expect(self.payload?.profile.id, JSON.stringify(self.error)).toBe(ada);
        });
        // The renamed-away login is refused at admission, before hello, sessions, or role methods.
        await withPerson("ada@github", async (ws, connected) => {
          expect(connected).toMatchObject({ ok: false, error: GITHUB_RATE_LIMITED_ERROR });
          expect(await waitForWsClose(ws, 1_000)).toBe(true);
        });
        // The reassigned login reaches only its new account's guest profile, never the former one.
        await withPerson("grace@github", async (ws, connected) => {
          expect(responseAuth(connected)?.scopes).toEqual(["operator.read"]);
          const self = await rpcReq<UsersSelfResult>(ws, "users.self");
          expect(self.payload?.profile.id, JSON.stringify(self.error)).toBe(graceSuccessor);
          expect(await rpcReq(ws, "sessions.patch", { key: "agent:main:x", label: "x" })).toEqual(
            expect.objectContaining({
              ok: false,
              error: expect.objectContaining({
                message: expect.stringContaining("operator.write"),
              }),
            }),
          );
        });
      } finally {
        for (const profileId of staffProfileIds) {
          invalidateOperatorRolePolicy(profileId);
        }
      }
    });
    expect(github.requests).toEqual([
      "/users/ada",
      "/users/grace",
      "/users/ada-lovelace",
      "/users/grace",
      "/users/ada-lovelace",
    ]);
  });

  test("caps a broader reconnect before device scope-upgrade comparison", async () => {
    await configureGatewayAuth(proxyAuth({ "admin@example.com": ["operator.admin"] }));
    const identityPath = deviceIdentityPath("identity-scope-reconnect-cap");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const initialWs = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const initial = await connectIdentity(initialWs, {
          skipDefaultAuth: true,
          scopes: ["operator.read"],
          deviceIdentityPath: identityPath,
        });
        expect(initial.ok).toBe(true);
      } finally {
        initialWs.close();
      }

      const reconnectWs = await openWs(port, {
        ...TRUSTED_PROXY_HEADERS,
        "x-openclaw-scopes": "operator.read",
      });
      try {
        const reconnect = await connectIdentity(reconnectWs, {
          skipDefaultAuth: true,
          prePairDevice: false,
          scopes: ["operator.read", "operator.write"],
          deviceIdentityPath: identityPath,
        });
        expect(reconnect.ok).toBe(true);
        expect(responseAuth(reconnect)?.scopes).toEqual(["operator.read"]);
      } finally {
        reconnectWs.close();
      }
    });

    expect((await getPairedDevice(identity.deviceId))?.approvedScopes).toEqual(["operator.read"]);
    expect(
      (await listDevicePairing()).pending.filter((entry) => entry.deviceId === identity.deviceId),
    ).toEqual([]);
  });

  test("does not trust an identity header without authentication", async () => {
    await configureGatewayAuth({
      mode: "none",
      identityScopes: { "admin@example.com": ["operator.admin"] },
    });

    await withVerifiedIdentity(async (_ws, connected) => {
      expect(connected.ok).toBe(true);
      expect(responseAuth(connected)?.scopes).toEqual(["operator.read"]);
    });
  });

  test("does not grant operator scopes to node connections", async () => {
    await configureGatewayAuth(proxyAuth({ "admin@example.com": ["operator.admin"] }));

    await withVerifiedIdentity(
      async (_ws, connected) => {
        expect(connected.ok).toBe(true);
        expect(responseAuth(connected)?.scopes).toEqual([]);
      },
      { role: "node", scopes: [], client: NODE_CLIENT, browserOrigin: undefined },
    );
  });
});
