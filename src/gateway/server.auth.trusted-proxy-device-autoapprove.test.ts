import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { confirmGatewayReachable } from "../cli/daemon-cli/restart-health-probe.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { loadDeviceAuthTokenReadOnly, storeDeviceAuthToken } from "../infra/device-auth-store.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  getPairedDevice,
  listDevicePairing,
  rejectDevicePairing,
  removePairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { loggingState } from "../logging/state.js";
import { resolveGatewayClientPlatformIdentity } from "../shared/gateway-client-platform.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import {
  BROWSER_ORIGIN,
  TRUSTED_BROWSER_HEADERS,
  CONTROL_UI_CLIENT,
  NODE_CLIENT,
  openWs,
} from "./server.auth.test-helpers.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  readConnectChallengeNonce,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const makeIdentityPath = useAuthIdentityFixture();

let sharedProxyGateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;
const clientSockets = new Set<WebSocket>();

beforeEach(async () => {
  if (!sharedProxyGateway) {
    return;
  }
  const pairing = await listDevicePairing();
  for (const pending of pairing.pending) {
    await rejectDevicePairing(pending.requestId);
  }
  for (const paired of pairing.paired) {
    await removePairedDevice(paired.deviceId);
  }
});
afterEach(async () => {
  await Promise.all(
    [...clientSockets].map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) {
        return;
      }
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }),
  );
  clientSockets.clear();
});
afterAll(closeSharedProxyGateway);

async function closeSharedProxyGateway(): Promise<void> {
  if (sharedProxyGateway) {
    await sharedProxyGateway.close();
    sharedProxyGateway = undefined;
  }
}

async function sharedProxyPort() {
  // Authentication is fixed; each handshake reads the case's current auto-approval policy.
  sharedProxyGateway ??= await createGatewaySuiteHarness();
  return sharedProxyGateway.port;
}

async function connectSharedUi(
  identityPath: string,
  params: Omit<Parameters<typeof connectOperatorUi>[0], "port" | "identityPath"> = {},
) {
  return connectOperatorUi({ port: await sharedProxyPort(), identityPath, ...params });
}

const READ = ["operator.read"];
const READ_WRITE = [...READ, "operator.write"];
const WITH_APPROVALS = [...READ_WRITE, "operator.approvals"];
const NATIVE_UI_CLIENT = {
  id: GATEWAY_CLIENT_IDS.MACOS_APP,
  mode: GATEWAY_CLIENT_MODES.UI,
  platform: "macOS 26.0",
  version: "1.0.0",
} satisfies ConnectParams["client"];
const TRUSTED_PROXY_HEADERS = {
  ...TRUSTED_BROWSER_HEADERS,
  "x-forwarded-user": "operator@example.com",
};

function trustedProxyHeaders(declaredScopes?: string): Record<string, string> {
  return {
    ...TRUSTED_PROXY_HEADERS,
    ...(declaredScopes === undefined ? {} : { "x-openclaw-scopes": declaredScopes }),
  };
}

function deviceIdentityPath(label: string): string {
  return makeIdentityPath(`openclaw-${label}-${randomUUID()}.sqlite`);
}

async function writeGatewayAuthConfig(params: {
  mode: "token" | "trusted-proxy";
  deviceAutoApprove?: { enabled?: boolean; scopes?: string[] };
}): Promise<void> {
  testState.gatewayAuth = undefined;
  await writeConfigFile({
    gateway: {
      auth: {
        mode: params.mode,
        ...(params.mode === "token" ? { token: "secret" } : {}),
        trustedProxy: {
          userHeader: "x-forwarded-user",
          ...(params.mode === "trusted-proxy"
            ? {
                requiredHeaders: ["x-forwarded-proto"],
                allowUsers: ["operator@example.com"],
                allowLoopback: true,
              }
            : {}),
          ...(params.deviceAutoApprove ? { deviceAutoApprove: params.deviceAutoApprove } : {}),
        },
      },
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

async function pendingFor(deviceId: string) {
  return (await listDevicePairing()).pending.filter((entry) => entry.deviceId === deviceId);
}

async function withBrowserWs<T>(
  port: number,
  headers: Record<string, string>,
  run: (ws: WebSocket) => Promise<T>,
) {
  const ws = await openWs(port, headers);
  clientSockets.add(ws);
  try {
    return await run(ws);
  } finally {
    ws.close();
  }
}

async function prepareAutoApproval(scopes?: string[]) {
  await writeGatewayAuthConfig({
    mode: "trusted-proxy",
    deviceAutoApprove: { enabled: true, scopes: scopes && [...scopes] },
  });
  const identityPath = deviceIdentityPath("auto-approval");
  return { identityPath, identity: loadOrCreateDeviceIdentity({ path: identityPath }) };
}

async function expectApprovedScopes(deviceId: string, scopes: string[]) {
  expect((await getPairedDevice(deviceId))?.approvedScopes).toEqual(scopes);
}

async function expectConnected(response: ReturnType<typeof connectOperatorUi>) {
  await expect(response).resolves.toMatchObject({ ok: true });
}

async function signedDevice(
  ws: WebSocket,
  identity: ReturnType<typeof loadOrCreateDeviceIdentity>,
  scopes: string[],
  deviceId = identity.deviceId,
) {
  const nonce = await readConnectChallengeNonce(ws);
  if (!nonce) {
    throw new Error("missing connect.challenge nonce");
  }
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId,
    clientId: CONTROL_UI_CLIENT.id,
    clientMode: CONTROL_UI_CLIENT.mode,
    role: "operator",
    scopes,
    signedAtMs: signedAt,
    token: null,
    nonce,
    platform: CONTROL_UI_CLIENT.platform,
  });
  return {
    id: deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt,
    nonce,
  };
}

async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => warnings.push(message)),
    error: vi.fn(),
  };
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  try {
    await run();
  } finally {
    loggingState.rawConsole = null;
    resetLogger();
  }
  return warnings;
}

async function connectOperatorUi(params: {
  client?: ConnectParams["client"];
  port: number;
  identityPath: string;
  scopes?: string[];
  token?: string;
  trustedProxy?: boolean;
  declaredProxyScopes?: string;
}) {
  const { client = CONTROL_UI_CLIENT, identityPath, scopes, token } = params;
  const headers: Record<string, string> =
    params.trustedProxy === false
      ? { origin: BROWSER_ORIGIN, "x-forwarded-for": "203.0.113.50" }
      : trustedProxyHeaders(params.declaredProxyScopes);
  if (client.mode === GATEWAY_CLIENT_MODES.UI) {
    delete headers.origin;
  }
  return withBrowserWs(params.port, headers, (ws) =>
    connectReq(ws, {
      ...(token ? { token } : { skipDefaultAuth: true }),
      ...(scopes === undefined ? {} : { scopes: [...scopes] }),
      client,
      deviceIdentityPath: identityPath,
    }),
  );
}

async function connectBrowserWithoutScopes(params: {
  port: number;
  identityPath: string;
  declaredProxyScopes?: string;
}): Promise<{ ok: boolean }> {
  return withBrowserWs(params.port, trustedProxyHeaders(params.declaredProxyScopes), async (ws) => {
    const identity = loadOrCreateDeviceIdentity({ path: params.identityPath });
    const device = await signedDevice(ws, identity, []);
    const id = randomUUID();
    const response = onceMessage<{ type: "res"; id: string; ok: boolean }>(
      ws,
      (message) => message.type === "res" && message.id === id,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: CONTROL_UI_CLIENT,
          caps: [],
          commands: [],
          role: "operator",
          device,
        },
      }),
    );
    return await response;
  });
}

describe("trusted-proxy operator device auto-approval", () => {
  test("restart health reuses the service profile's paired identity without proxy credentials", async () => {
    await writeGatewayAuthConfig({ mode: "trusted-proxy" });
    await withOpenClawTestState({ applyEnv: false }, async (clientState) => {
      const env = clientState.env;
      const identity = loadOrCreateDeviceIdentity({ env });
      const deviceAuth = { env, deviceId: identity.deviceId, role: "operator" };
      const pending = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        clientId: GATEWAY_CLIENT_IDS.CLI,
        clientMode: GATEWAY_CLIENT_MODES.CLI,
        ...resolveGatewayClientPlatformIdentity(process.platform),
        role: "operator",
        scopes: ["operator.read"],
      });
      const approved = await approveDevicePairing(pending.request.requestId, {
        callerScopes: ["operator.read"],
      });
      expect(approved?.status).toBe("approved");
      await withGatewayServer(async ({ port }) => {
        const auth = (await getPairedDevice(identity.deviceId))?.tokens?.operator;
        if (!auth) {
          throw new Error("Fixture operator device was not paired");
        }
        await storeDeviceAuthToken({
          ...deviceAuth,
          token: auth.token,
          scopes: auth.scopes,
        });
        const stored = await loadDeviceAuthTokenReadOnly(deviceAuth);
        const health = await confirmGatewayReachable({
          env,
          port,
          config: loadConfig(),
          timeoutMs: 3_000,
        });
        expect(health).toMatchObject({
          reachable: true,
          activatedPluginErrors: [],
          channelProbeErrors: [],
          gatewayVersion: expect.any(String),
          gatewayBootId: expect.any(String),
        });
        expect(await loadDeviceAuthTokenReadOnly(deviceAuth)).toEqual(stored);
        expect(loadDeviceIdentityIfPresent({ env })).toEqual(identity);
        expect((await listDevicePairing()).pending).toEqual([]);
      });
    });
  });

  test("auto-approves operator.admin and warns once at startup", async () => {
    const { identityPath, identity } = await prepareAutoApproval(["operator.admin"]);
    const warnings = await captureWarnings(async () => {
      await withGatewayServer(async ({ port }) => {
        await expectConnected(
          connectOperatorUi({ port, identityPath, scopes: ["operator.admin"] }),
        );
      });
      await withGatewayServer(async () => {}, {
        serverOptions: { auth: { mode: "token", token: "secret" } },
      });
    });

    expect(
      warnings.filter((message) =>
        message.includes(
          "SECURITY WARNING: gateway.auth.trustedProxy.deviceAutoApprove.scopes includes operator.admin; every proxy-authenticated user can auto-approve a new operator device with full admin, and requests without scopes receive full admin automatically. Remove operator.admin and grant admin per identity via gateway.auth.identityScopes instead.",
        ),
      ),
    ).toHaveLength(1);
    expect(await getPairedDevice(identity.deviceId)).toMatchObject({
      approvedScopes: ["operator.admin"],
      tokens: { operator: { scopes: ["operator.admin", "operator.read", "operator.write"] } },
      approvedVia: "trusted-proxy",
    });
  });

  test("auto-approves a new control-ui operator with the default scopes", async () => {
    const { identityPath, identity } = await prepareAutoApproval();
    await expectConnected(connectSharedUi(identityPath, { scopes: WITH_APPROVALS }));

    expect(await pendingFor(identity.deviceId)).toEqual([]);
    expect(await getPairedDevice(identity.deviceId)).toMatchObject({
      approvedScopes: ["operator.approvals", "operator.questions", ...READ_WRITE],
      approvedVia: "trusted-proxy",
    });
  });

  test("leaves mixed node and operator requests pending for manual approval", async () => {
    const { identityPath, identity } = await prepareAutoApproval(READ);

    const port = await sharedProxyPort();
    await withBrowserWs(port, trustedProxyHeaders(), async (nodeWs) => {
      const nodeRes = await connectReq(nodeWs, {
        skipDefaultAuth: true,
        client: NODE_CLIENT,
        role: "node",
        scopes: [],
        deviceIdentityPath: identityPath,
      });
      expect(nodeRes.ok).toBe(false);
    });
    expect((await connectSharedUi(identityPath, { scopes: READ })).ok).toBe(false);

    await expect(getPairedDevice(identity.deviceId)).resolves.toBeNull();
    expect(
      (await listDevicePairing()).pending.find((entry) => entry.deviceId === identity.deviceId),
    ).toMatchObject({ roles: ["node", "operator"] });
  });

  test.each<[string[], string, string[]]>([
    [WITH_APPROVALS, "operator.read", READ],
    [["operator.write"], "operator.read", READ],
    [WITH_APPROVALS, "", []],
  ])(
    "caps omitted scopes %j to declared proxy scopes '%s'",
    async (configuredScopes, declaredProxyScopes, expectedScopes) => {
      const { identityPath, identity } = await prepareAutoApproval(configuredScopes);

      expect(
        (
          await connectBrowserWithoutScopes({
            port: await sharedProxyPort(),
            identityPath,
            declaredProxyScopes,
          })
        ).ok,
      ).toBe(true);
      await expectApprovedScopes(identity.deviceId, expectedScopes);
    },
  );

  test("caps requested scopes to the configured and declared proxy scopes", async () => {
    const { identityPath, identity } = await prepareAutoApproval(WITH_APPROVALS);
    await expectConnected(
      connectSharedUi(identityPath, {
        scopes: [...READ_WRITE, "operator.admin"],
        declaredProxyScopes: "operator.read",
      }),
    );
    await expectApprovedScopes(identity.deviceId, READ);
  });

  test("keeps configured and requested scope behavior when the proxy header is absent", async () => {
    const { identityPath: omittedIdentityPath, identity: omittedIdentity } =
      await prepareAutoApproval(["operator.read", "operator.approvals"]);
    const requestedIdentityPath = deviceIdentityPath("trusted-proxy-requested-scopes-no-cap");
    const requestedIdentity = loadOrCreateDeviceIdentity({ path: requestedIdentityPath });

    expect(
      (
        await connectBrowserWithoutScopes({
          port: await sharedProxyPort(),
          identityPath: omittedIdentityPath,
        })
      ).ok,
    ).toBe(true);
    await expectConnected(connectSharedUi(requestedIdentityPath, { scopes: READ_WRITE }));
    await expectApprovedScopes(omittedIdentity.deviceId, ["operator.approvals", "operator.read"]);
    await expectApprovedScopes(requestedIdentity.deviceId, READ);
  });

  test("auto-approves same-key scope upgrades on existing devices", async () => {
    const client = NATIVE_UI_CLIENT;
    const { identityPath, identity } = await prepareAutoApproval(READ_WRITE);
    await expectConnected(connectSharedUi(identityPath, { client, scopes: READ }));
    await expectConnected(connectSharedUi(identityPath, { client, scopes: READ_WRITE }));

    expect(await pendingFor(identity.deviceId)).toHaveLength(0);
    await expectApprovedScopes(identity.deviceId, READ_WRITE);
  });

  test("narrows same-key reconnects without a pairing round-trip", async () => {
    const { identityPath, identity } = await prepareAutoApproval(READ_WRITE);
    await expectConnected(connectSharedUi(identityPath, { scopes: READ_WRITE }));
    const warnings = await captureWarnings(async () => {
      const reconnect = await connectSharedUi(identityPath, {
        scopes: ["operator.read", "operator.write", "operator.admin", "operator.pairing"],
      });
      expect(reconnect.ok).toBe(true);
      expect((reconnect.payload as { auth?: { scopes?: string[] } })?.auth?.scopes).toEqual(
        READ_WRITE,
      );
    });

    expect(await pendingFor(identity.deviceId)).toEqual([]);
    await expectApprovedScopes(identity.deviceId, READ_WRITE);
    expect(
      warnings.filter((message) => /device access upgrade requested|auto-approved/.test(message)),
    ).toEqual([]);
  });

  test("rejects a foreign-key connect for an already-paired deviceId", async () => {
    const { identityPath, identity } = await prepareAutoApproval(READ_WRITE);
    const attackerIdentity = loadOrCreateDeviceIdentity({
      path: deviceIdentityPath("trusted-proxy-key-mismatch-attacker"),
    });

    await expectConnected(connectSharedUi(identityPath, { scopes: READ }));
    // A valid signature from a foreign key must not inherit the paired deviceId's authority.
    await withBrowserWs(await sharedProxyPort(), trustedProxyHeaders(), async (ws) => {
      const response = await connectReq(ws, {
        skipDefaultAuth: true,
        client: CONTROL_UI_CLIENT,
        scopes: READ_WRITE,
        device: await signedDevice(ws, attackerIdentity, READ_WRITE, identity.deviceId),
      });
      expect(response.ok).toBe(false);
    });

    expect(await pendingFor(identity.deviceId)).toEqual([]);
    expect(await getPairedDevice(identity.deviceId)).toMatchObject({
      approvedScopes: ["operator.read"],
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    });
  });

  test.each([
    { client: NATIVE_UI_CLIENT, role: "node", scopes: [] },
    {
      client: { ...NATIVE_UI_CLIENT, mode: GATEWAY_CLIENT_MODES.BACKEND },
      role: "operator",
      scopes: ["operator.read"],
    },
    {
      client: { ...NATIVE_UI_CLIENT, id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT },
      role: "operator",
      scopes: ["operator.read"],
    },
  ])(
    "does not auto-approve $client.id/$client.mode with role $role",
    async ({ client, role, scopes }) => {
      const { identityPath, identity } = await prepareAutoApproval();
      const headers = trustedProxyHeaders();
      delete headers.origin;
      await withBrowserWs(await sharedProxyPort(), headers, async (ws) => {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client,
          role,
          scopes,
          deviceIdentityPath: identityPath,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message).toContain("pairing required");
      });
      expect(await getPairedDevice(identity.deviceId)).toBeNull();
      expect(await pendingFor(identity.deviceId)).toHaveLength(1);
    },
  );

  test("does not auto-approve token-authenticated browser devices", async () => {
    await closeSharedProxyGateway();
    await writeGatewayAuthConfig({
      mode: "token",
      deviceAutoApprove: { enabled: true, scopes: ["operator.approvals"] },
    });
    const identityPath = deviceIdentityPath("token-auth-disabled");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const res = await connectOperatorUi({
        port,
        identityPath,
        scopes: ["operator.read"],
        token: "secret",
        trustedProxy: false,
      });
      expect(res.ok).toBe(true);
    });

    expect(await pendingFor(identity.deviceId)).toEqual([]);
    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.approvedScopes).toEqual(["operator.read"]);
    expect(paired?.approvedVia).not.toBe("trusted-proxy");
  });
});
