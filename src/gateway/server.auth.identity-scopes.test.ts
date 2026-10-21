import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  buildGatewayConnectAuth,
  selectGatewayConnectAuth,
} from "../../packages/gateway-client/src/connect-auth.js";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
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
import { gitHubPublicApi } from "./github-public-api.js";
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
const NARROW_SCOPES: OperatorScope[] = ["operator.read", "operator.write", "operator.talk"];
const READ_WRITE: OperatorScope[] = ["operator.read", "operator.write"];
const ADMIN_GRANT = { "admin@example.com": ["operator.admin"] } satisfies NonNullable<
  GatewayAuthConfig["identityScopes"]
>;
const UPGRADE_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];

function deviceIdentityPath(label: string): string {
  return path.join(
    tempDirs.make("openclaw-identity-scopes-"),
    label,
    "client",
    "credentials.sqlite",
  );
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
  roles?: GatewayOperatorRolesConfig,
  tailscale = false,
): Promise<void> {
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      ...(tailscale ? { tailscale: { mode: "serve" } } : {}),
      ...(roles ? { roles } : {}),
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

function responseAuth(response: Connected): HelloOk["auth"] | undefined {
  return (response.payload as HelloOk | undefined)?.auth;
}

type ConnectOptions = NonNullable<Parameters<typeof connectReq>[1]>;
type Connected = Awaited<ReturnType<typeof connectReq>>;
type IdentityRun<T = void> = (ws: WebSocket, connected: Connected) => Promise<T>;

function identityConnections(port: number, server: GatewayServer) {
  const connectSocket = async (socket: Promise<WebSocket>, options: ConnectOptions) => {
    const ws = await socket;
    const connected = await connectReq(ws, {
      prePairDevice: true,
      client: CONTROL_UI_CLIENT,
      browserOrigin: BROWSER_ORIGIN,
      skipDefaultAuth: true,
      scopes: ["operator.read"],
      deviceIdentityPath: options.deviceIdentityPath ?? deviceIdentityPath("identity-scope"),
      ...options,
    });
    return { ws, connected };
  };
  return {
    server,
    connect: (
      options: ConnectOptions = {},
      headers: Parameters<typeof openWs>[1] = TRUSTED_PROXY_HEADERS,
    ) => connectSocket(openWs(port, headers), options),
    tailscale: (login: string, options: ConnectOptions = {}) =>
      connectSocket(
        openTailscaleWs(tailscaleEndpoint(server), {
          origin: BROWSER_ORIGIN,
          "tailscale-user-login": login,
        }),
        options,
      ),
  };
}

async function withIdentityServer(
  run: (connections: ReturnType<typeof identityConnections>) => Promise<void>,
) {
  // withGatewayServer closes every admitted socket; explicit closes below exercise reconnects.
  await withGatewayServer(({ port, server }) => run(identityConnections(port, server)));
}

function expectScopes(connected: Connected, scopes: string[]) {
  expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
  expect(responseAuth(connected)?.scopes).toEqual(scopes);
}

async function expectUnchangedPairing(deviceId: string, scopes: string[]) {
  expect((await getPairedDevice(deviceId))?.approvedScopes).toEqual(scopes);
  expect(
    (await listDevicePairing()).pending.filter((entry) => entry.deviceId === deviceId),
  ).toEqual([]);
}

function configureTailscale(
  auth: Partial<GatewayAuthConfig> = {},
  roles?: GatewayOperatorRolesConfig,
) {
  return configureGatewayAuth(
    { mode: "token", token: "secret", allowTailscale: true, ...auth },
    roles,
    true,
  );
}

function tailscaleEndpoint(server: Pick<GatewayServer, "getTailscaleIngressEndpoint">) {
  const endpoint = server.getTailscaleIngressEndpoint();
  if (!endpoint) {
    throw new Error("expected managed Tailscale listener");
  }
  return endpoint;
}

async function verifiedProfile(ws: WebSocket, connected: Connected) {
  expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
  const self = await rpcReq<UsersSelfResult>(ws, "users.self");
  expect(self.ok, JSON.stringify(self.error)).toBe(true);
  return self.payload?.profile.id;
}

async function expectPayload(ws: WebSocket, method: string, payload: unknown, params?: object) {
  const result = await rpcReq(ws, method, params);
  expect(result, JSON.stringify(result.error)).toMatchObject({ ok: true, payload });
}

async function expectWriteDenied(ws: WebSocket, key: string) {
  expect(await rpcReq(ws, "sessions.patch", { key, label: "denied" })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("operator.write") },
  });
}

function expectProfile(ws: WebSocket, id: string | undefined) {
  return expectPayload(ws, "users.self", { profile: { id } });
}

function roleCase(
  label: string,
  assignedRole: string | undefined,
  expectedScopes: OperatorScope[],
  deviceScopes: OperatorScope[] = ["operator.read", "operator.write"],
  identityScopes: OperatorScope[] = ["operator.admin"],
) {
  return { label, assignedRole, expectedScopes, deviceScopes, identityScopes };
}

function role(
  scopes: OperatorScope[],
  others: "none" | "view" | "write" = "view",
  agents: "*" | string[] = "*",
) {
  return { sessions: { others }, agents, scopes };
}

const GITHUB_RATE_LIMITED_ERROR = {
  code: "UNAVAILABLE",
  message: expect.stringContaining("GitHub is rate limiting profile verification"),
  retryAfterMs: expect.toSatisfy((ms: number) => ms > 60_000),
};

/** Stubs only api.github.com user lookups; `quotaExhausted` switches to GitHub's real 403. */
function stubGitHubUserLookups(users: Record<string, { id: number; login: string }>) {
  // Load the source plugin before opening sockets and starting handshake deadlines.
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  const githubApiOrigin = gitHubPublicApi.GITHUB_API_ORIGIN;
  const realFetch = globalThis.fetch;
  const github = { requests: [] as string[], quotaExhausted: false };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== githubApiOrigin) {
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
  { tailscale }: ReturnType<typeof identityConnections>,
  scopes = ["operator.read"],
) {
  return async <T>(login: string, run: IdentityRun<T>) => {
    testTailscaleWhois.value = { login, name: login };
    const { ws, connected } = await tailscale(login, { scopes });
    try {
      return await run(ws, connected);
    } finally {
      ws.close();
    }
  };
}

test("denies missing person access, retires grant or alias authority, and preserves staff", async () => {
  await configureGatewayAuth(proxyAuth(), {
    default: "reader",
    definitions: {
      reader: { accessPolicyPlugin: "person-access", ...role(["operator.read"]) },
      staff: role(["operator.admin"], "write"),
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
  await withIdentityServer(async ({ connect: connectIdentity }) => {
    const connect = (email: string) => {
      return connectIdentity({}, { ...TRUSTED_PROXY_HEADERS, "x-forwarded-user": email });
    };
    const accessPolicies = getTestPluginRegistry().gatewayAccessPolicies;
    const registeredPolicies = [...accessPolicies];
    try {
      grant = new AbortController();
      accessPolicies.length = 0;
      expect((await connect("visitor@example.com")).connected).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", details: { code: "OPERATOR_ACCESS_DENIED" } },
      });
      const staff = await connect("staff@example.com");
      expect(staff.connected.ok).toBe(true);
      accessPolicies.push(...registeredPolicies);
      grant = undefined;
      expect((await connect("visitor@example.com")).connected).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", details: { code: "OPERATOR_ACCESS_DENIED" } },
      });
      grant = new AbortController();
      const guest = await connect("visitor@example.com");
      expect(guest.connected.ok).toBe(true);
      expect((await rpcReq(guest.ws, "status")).ok).toBe(true);
      grant.abort(new Error("Grant expired"));
      expect(await waitForWsClose(guest.ws, 1_000)).toBe(true);
      expect((await rpcReq(staff.ws, "status")).ok).toBe(true);
      expect((await connect("visitor@example.com")).connected.ok).toBe(false);

      grant = new AbortController();
      const person = ensureProfileForEmail("visitor@example.com");
      linkEmail("retained@example.com", person.id);
      const replacement = ensureProfileForEmail("replacement@example.com");
      const aliasGuest = await connect("visitor@example.com");
      expect(aliasGuest.connected.ok).toBe(true);
      setDisplayName(person.id, "Updated visitor");
      linkEmail("added@example.com", person.id);
      expect((await rpcReq(aliasGuest.ws, "status")).ok).toBe(true);

      const closed = waitForWsClose(aliasGuest.ws, 1_000);
      linkEmail("visitor@example.com", replacement.id);
      linkEmail("visitor@example.com", person.id);
      expect(await closed).toBe(true);
      expect(grant.signal.aborted).toBe(false);
      expect((await rpcReq(staff.ws, "status")).ok).toBe(true);
      expect((await connect("visitor@example.com")).connected.ok).toBe(true);
    } finally {
      accessPolicies.splice(0, accessPolicies.length, ...registeredPolicies);
    }
  });
});

test.each([
  roleCase("unassigned default guest", undefined, READ_WRITE),
  roleCase("admin-only without identity grants", "admin-only", NARROW_SCOPES, NARROW_SCOPES, []),
  roleCase("read-only from an admin-only identity grant", "read-only", ["operator.read"], []),
  roleCase("empty", "denied", [], NARROW_SCOPES),
])("applies the $label role ceiling after device and identity grants", async (scenario) => {
  await configureGatewayAuth(proxyAuth({ "admin@example.com": scenario.identityScopes }), {
    default: "guest",
    definitions: {
      guest: role(READ_WRITE),
      "admin-only": role(["operator.admin"], "write"),
      "read-only": role(["operator.read"]),
      denied: role([], "none", []),
    },
  });
  const profile = ensureProfileForEmail("admin@example.com");
  if (scenario.assignedRole) {
    setUserProfileRole(profile.id, scenario.assignedRole);
  }

  await withIdentityServer(async ({ connect }) => {
    const { ws, connected } = await connect({ scopes: scenario.deviceScopes });
    try {
      expectScopes(connected, scenario.expectedScopes);
      expect((await rpcReq(ws, "status")).ok).toBe(scenario.expectedScopes.length > 0);
      if (scenario.assignedRole === "read-only") {
        await expectWriteDenied(ws, "agent:main:denied");
      }
      expect(responseAuth(connected)?.deviceToken).toBe(undefined);
      expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(false);
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
        const { ws: admin, connected: adminConnected } = await connect({
          scopes: ["operator.admin"],
        });
        expect(adminConnected.ok).toBe(true);
        expect(responseAuth(adminConnected)?.deviceToken).toBeUndefined();
        const registration = await rpcReq<{ requestId: string }>(
          ws,
          "device.scopes.requestUpgrade",
          { scopes: UPGRADE_SCOPES },
        );
        expect(registration.ok).toBe(true);
        const requestId = registration.payload?.requestId;
        expect(requestId).toBeTypeOf("string");
        expect((await rpcReq(admin, "device.pair.approve", { requestId })).ok).toBe(true);
        const result = await rpcReq<{ deviceToken: string }>(ws, "device.scopes.waitUpgrade", {
          requestId,
        });
        expect(result).toMatchObject({
          ok: true,
          payload: { status: "approved", scopes: [...UPGRADE_SCOPES, "operator.talk"].toSorted() },
        });
        expect(result.payload?.deviceToken).toBeTypeOf("string");
        expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(false);
      }
    } finally {
      invalidateOperatorRolePolicy(profile.id);
    }
  });
});

test("lets the shared-token owner manage accounts across device-token reconnects", async () => {
  await configureGatewayAuth({ mode: "token", token: "secret" });
  const identityPath = deviceIdentityPath("model-account-owner");
  await withIdentityServer(async ({ connect }) => {
    let deviceToken: string | undefined;
    let authProfileId: string | undefined;
    for (const reconnect of [false, true]) {
      const { ws, connected } = await connect(
        {
          skipDefaultAuth: reconnect,
          ...(reconnect ? { deviceToken } : {}),
          prePairDevice: !reconnect,
          scopes: READ_WRITE,
          deviceIdentityPath: identityPath,
        },
        { origin: BROWSER_ORIGIN },
      );
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      await expectProfile(ws, GATEWAY_OWNER_PROFILE_ID);
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
      await expectPayload(ws, "users.listModelAccounts", {
        profileId: GATEWAY_OWNER_PROFILE_ID,
        accounts: [{ authProfileId, provider: "anthropic", selected: false }],
        links: [],
      });
      await expectPayload(
        ws,
        "users.selectModelAccount",
        { links: [{ authProfileId, provider: "anthropic" }] },
        { authProfileId },
      );
      await expectPayload(ws, "users.listModelAccounts", {
        accounts: [expect.objectContaining({ authProfileId, selected: true })],
      });
      ws.close();
      expect(await waitForWsClose(ws, 1_000)).toBe(true);
    }
  });
});

test("does not cap shared-secret clients without a durable profile", async () => {
  await configureGatewayAuth(
    { mode: "token", token: "secret" },
    { default: "guest", definitions: { guest: role(["operator.read"], "none", []) } },
  );

  await withIdentityServer(async ({ connect }) => {
    const identityPath = deviceIdentityPath("identity-role-shared-secret");
    const options = { scopes: READ_WRITE, deviceIdentityPath: identityPath };
    const headers = { origin: BROWSER_ORIGIN };
    const { connected } = await connect(
      { ...options, skipDefaultAuth: false, token: "secret" },
      headers,
    );
    expectScopes(connected, READ_WRITE);
    const deviceToken = responseAuth(connected)?.deviceToken;
    expect(deviceToken).toBeTypeOf("string");
    const { connected: rejected } = await connect(
      { ...options, prePairDevice: false, deviceToken },
      headers,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("verified user identity") },
    });
  });
});

test("adds a case-insensitive trusted-proxy email grant without changing pairing", async () => {
  await configureGatewayAuth(proxyAuth(ADMIN_GRANT));
  const identityPath = deviceIdentityPath("identity-scope-device");
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  const configuredWorkspace = tempDirs.make("openclaw-identity-workspace-");
  const outsideWorkspace = tempDirs.make("openclaw-identity-outside-");
  testState.agentConfig = { workspace: configuredWorkspace };

  try {
    await withIdentityServer(async ({ connect }) => {
      const { ws, connected } = await connect(
        { scopes: ["operator.write"], deviceIdentityPath: identityPath },
        { ...TRUSTED_PROXY_HEADERS, "x-forwarded-user": "Admin@Example.com" },
      );
      expectScopes(connected, ["operator.write", "operator.admin"]);
      expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(true);
      const browse = await rpcReq<{ path?: string }>(ws, "fs.listDir", {
        path: outsideWorkspace,
      });
      expect(browse, JSON.stringify(browse.error)).toMatchObject({
        ok: true,
        payload: { path: outsideWorkspace },
      });
    });
  } finally {
    testState.agentConfig = undefined;
  }

  await expectUnchangedPairing(identity.deviceId, ["operator.write"]);
});

test.each<[string, OperatorScope[]]>([
  ["peter", ["operator.read", "operator.admin"]],
  ["Peter", ["operator.read"]],
])(
  "matches verified Tailscale identity peter exactly (%s)",
  async (configuredIdentity, expectedScopes) => {
    await configureTailscale({ identityScopes: { [configuredIdentity]: ["operator.admin"] } });
    testTailscaleWhois.value = { login: "peter", name: "Peter" };

    await withIdentityServer(async ({ tailscale }) => {
      const { connected } = await tailscale("peter");
      expectScopes(connected, expectedScopes);
    });
  },
);

test.each<[string, string | undefined, boolean]>([
  ["verified person with cached device auth", undefined, true],
  ["explicit shared-token authority", "secret", false],
])("preserves %s on a second Tailscale connection", async (_authentication, token, usePerson) => {
  await configureTailscale();
  const login = "cached-person@example.com";
  testTailscaleWhois.value = { login, name: "Cached Person" };
  const identityPath = deviceIdentityPath("identity-tailscale-reconnect");
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });

  await withIdentityServer(async ({ server, tailscale }) => {
    const endpoint = tailscaleEndpoint(server);
    const cacheKey = {
      gatewayScope: `ws://${endpoint.host}:${endpoint.port}`,
      deviceId: identity.deviceId,
      role: "operator",
    };
    const options = { scopes: READ_WRITE, deviceIdentityPath: identityPath };
    const { ws: initialWs, connected: initial } = await tailscale(login, options);
    const profileId = await verifiedProfile(initialWs, initial);
    expect(profileId).toBeTypeOf("string");
    expect(profileId).not.toBe(GATEWAY_OWNER_PROFILE_ID);
    const initialAuth = (initial.payload as HelloOk).auth;
    if (!initialAuth.deviceToken) {
      throw new Error("expected a Gateway-issued device token");
    }
    seedOriginDeviceToken({
      ...cacheKey,
      token: initialAuth.deviceToken,
      scopes: initialAuth.scopes,
    });
    initialWs.close();
    expect(await waitForWsClose(initialWs, 1_000)).toBe(true);

    const cached = await loadOriginDeviceToken(cacheKey);
    if (!cached) {
      throw new Error("expected the first connection's cached device token");
    }
    const auth = buildGatewayConnectAuth(
      selectGatewayConnectAuth({ token, storedToken: cached.token, storedScopes: cached.scopes }),
    );
    const { ws, connected } = await tailscale(login, { ...options, ...auth, prePairDevice: false });
    expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
    await expectProfile(ws, usePerson ? profileId : GATEWAY_OWNER_PROFILE_ID);
    ws.close();
    expect(await waitForWsClose(ws, 1_000)).toBe(true);
  });
});

test("keeps a verified GitHub person signed in while anonymous GitHub quota is exhausted", async () => {
  await configureTailscale();
  const github = stubGitHubUserLookups({ ada: { id: 583231, login: "ada" } });

  await withIdentityServer(async (connections) => {
    const withPerson = gitHubTailscalePeople(connections);
    const profileId = await withPerson("ada@github", verifiedProfile);

    github.quotaExhausted = true;
    await withPerson("ada@github", async (ws, connected) => {
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      await expectProfile(ws, profileId);
      expect((await rpcReq(ws, "sessions.list")).ok).toBe(true);
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
  await configureTailscale(
    {},
    {
      default: "guest",
      definitions: { guest: role(["operator.read"], "none", []), staff: role(READ_WRITE, "write") },
    },
  );
  const users: Record<string, { id: number; login: string }> = {
    ada: { id: 583231, login: "ada" },
    grace: { id: 1001, login: "grace" },
  };
  const github = stubGitHubUserLookups(users);
  const staffProfileIds: string[] = [];

  await withIdentityServer(async (connections) => {
    const withPerson = gitHubTailscalePeople(connections, READ_WRITE);
    const profileOf = async (login: string) => {
      const profileId = await withPerson(login, verifiedProfile);
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

      users["ada-lovelace"] = { id: 583231, login: "ada-lovelace" };
      expect(await profileOf("ada-lovelace@github")).toBe(ada);
      users.grace = { id: 2002, login: "grace" };
      const graceSuccessor = await profileOf("grace@github");
      expect(graceSuccessor).not.toBe(grace);

      github.quotaExhausted = true;
      await withPerson("ada-lovelace@github", async (ws, connected) => {
        expect(responseAuth(connected)?.scopes).toEqual(READ_WRITE);
        await expectProfile(ws, ada);
      });
      // The renamed-away login is refused at admission, before hello, sessions, or role methods.
      await withPerson("ada@github", async (ws, connected) => {
        expect(connected).toMatchObject({ ok: false, error: GITHUB_RATE_LIMITED_ERROR });
        expect(await waitForWsClose(ws, 1_000)).toBe(true);
      });
      // The reassigned login reaches only its new account's guest profile, never the former one.
      await withPerson("grace@github", async (ws, connected) => {
        expect(responseAuth(connected)?.scopes).toEqual(["operator.read"]);
        await expectProfile(ws, graceSuccessor);
        await expectWriteDenied(ws, "agent:main:x");
      });
    } finally {
      staffProfileIds.forEach(invalidateOperatorRolePolicy);
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
  await configureGatewayAuth(proxyAuth(ADMIN_GRANT));
  const identityPath = deviceIdentityPath("identity-scope-reconnect-cap");
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });

  await withIdentityServer(async ({ connect }) => {
    const { ws: initialWs, connected: initial } = await connect({
      deviceIdentityPath: identityPath,
    });
    expect(initial.ok).toBe(true);
    initialWs.close();

    const { connected: reconnect } = await connect(
      { prePairDevice: false, scopes: READ_WRITE, deviceIdentityPath: identityPath },
      { ...TRUSTED_PROXY_HEADERS, "x-openclaw-scopes": "operator.read" },
    );
    expectScopes(reconnect, ["operator.read"]);
  });

  await expectUnchangedPairing(identity.deviceId, ["operator.read"]);
});

test("keeps equivalent identity grants within both proxy scope ceilings", async () => {
  await configureGatewayAuth(
    proxyAuth({
      "explicit@example.com": READ_WRITE,
      "implied@example.com": ["operator.write"],
      "admin@example.com": ["operator.admin"],
      "read-only@example.com": ["operator.read"],
      "pairing-only@example.com": ["operator.pairing"],
    }),
  );
  const cases: Array<[string, string, OperatorScope[]]> = [
    ["explicit@example.com", "operator.read", ["operator.read"]],
    ["implied@example.com", "operator.read", ["operator.read"]],
    ["admin@example.com", "operator.read", ["operator.read"]],
    ["read-only@example.com", "operator.write", ["operator.read"]],
    ["pairing-only@example.com", "operator.read", []],
    ["implied@example.com", "", []],
  ];
  await withIdentityServer(async ({ connect }) => {
    for (const [identity, cap, expected] of cases) {
      const { ws, connected } = await connect(
        { device: null },
        { ...TRUSTED_PROXY_HEADERS, "x-forwarded-user": identity, "x-openclaw-scopes": cap },
      );
      expectScopes(connected, expected);
      expect((await rpcReq(ws, "sessions.list", {})).ok).toBe(expected.length > 0);
      await expectWriteDenied(ws, "agent:main:scope-cap");
      ws.close();
    }
  });
});

test.each<[string, GatewayAuthConfig, ConnectOptions, string[]]>([
  ["clears device-less scopes", proxyAuth(ADMIN_GRANT), { device: null }, ["operator.admin"]],
  [
    "ignores unauthenticated headers",
    { mode: "none", identityScopes: ADMIN_GRANT },
    {},
    ["operator.read"],
  ],
  [
    "withholds node scopes",
    proxyAuth(ADMIN_GRANT),
    { role: "node", scopes: [], client: NODE_CLIENT, browserOrigin: undefined },
    [],
  ],
])("%s", async (_label, auth, options, scopes) => {
  await configureGatewayAuth(auth);
  await withIdentityServer(async ({ connect }) => {
    const { connected } = await connect(options);
    expectScopes(connected, scopes);
  });
});
