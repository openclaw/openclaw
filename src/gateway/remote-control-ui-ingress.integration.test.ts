import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { loadDeviceBootstrapTokenRecords } from "../infra/device-pairing-store.js";
import { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
import { listDevicePairing, requestDevicePairing } from "../infra/device-pairing.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV1,
  type GatewayControlUiIngressV1,
  type GatewayIngressMessage,
} from "../plugins/gateway-ingress.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createSandboxHostHttpRequestHandler } from "./mcp-app-sandbox-http.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { createGatewayHttpRequestHandler } from "./server-http-request.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { attachGatewayWsConnectionHandler } from "./server/ws-connection.js";
import { createGatewayWsTestRequestContext } from "./server/ws-connection.test-helpers.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const PUBLIC_ORIGIN = "https://ui.example.test";
const SHARED_TOKEN = "remote-control-ui-integration-shared-token";
const SCOPES = ["operator.read", "operator.write"] as const;
const CLIENT = {
  id: "openclaw-control-ui",
  version: "dev",
  platform: "browser",
  mode: "webchat",
} as const;

type IngressFrame = {
  type: string;
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: {
    nonce?: string;
    type?: string;
    auth?: { method: string; role: string; scopes: string[] };
  };
  error?: { code: string; message: string };
};

async function readFrame(messages: AsyncIterator<GatewayIngressMessage>): Promise<IngressFrame> {
  const frame = await messages.next();
  if (frame.done || frame.value.kind !== "text") {
    throw new Error("Expected a Gateway JSON frame");
  }
  return JSON.parse(frame.value.text) as IngressFrame;
}

describe("remote Control UI ingress production composition", () => {
  let state: OpenClawTestState;
  let ingress: GatewayControlUiIngressV1 | undefined;
  let factory: GatewayControlUiIngressFactoryV1;
  let identity: DeviceIdentity;
  let freshIdentity: DeviceIdentity;
  let deviceToken: string;
  let config: OpenClawConfig;
  let auth: ResolvedGatewayAuth;
  let http: ReturnType<typeof createGatewayHttpRequestHandler> | undefined;
  const hostLifetime = new AbortController();
  const serviceLifetime = new AbortController();
  const grantLifetime = new AbortController();
  const clients = new GatewayClientRegistry();
  const upgradeServer = createServer();
  const connectionWork = new GatewayConnectionWork();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PREAUTH_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const openOptions = {
    audienceId: "synthetic-integration-grant",
    publicOrigin: PUBLIC_ORIGIN,
    sandboxOrigin: "https://sandbox.example.test",
    operatorScopeCeiling: SCOPES,
    frameAncestors: ["https://chat.example.test", "codex-sandbox:"],
    signal: grantLifetime.signal,
    assertCurrent: () => grantLifetime.signal.throwIfAborted(),
  };

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "remote-control-ui-ingress",
      layout: "state-only",
    });
    const root = path.dirname(
      await state.writeText(
        "ui/index.html",
        '<!doctype html><html><head><script type="module" src="./assets/app.js"></script></head><body>Remote UI fixture</body></html>',
      ),
    );
    await state.writeText("ui/assets/app.js", 'document.body.dataset.ready = "remote-ui";');
    config = {
      gateway: {
        auth: { mode: "token", token: SHARED_TOKEN },
        controlUi: { enabled: true, basePath: "/claw", root },
      },
      skills: { load: { watch: false } },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config, config);
    auth = { mode: "token", token: SHARED_TOKEN, allowTailscale: false };
    identity = loadOrCreateDeviceIdentity();
    freshIdentity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-fresh-remote-browser" });
    const pending = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      platform: CLIENT.platform,
      clientId: CLIENT.id,
      clientMode: CLIENT.mode,
      role: "operator",
      scopes: [...SCOPES],
    });
    await approveDevicePairing(pending.request.requestId, { callerScopes: [...SCOPES] });
    const generation = resolveSharedGatewaySessionGeneration(auth, []);
    if (!generation) {
      throw new Error("Missing shared-auth issuer generation");
    }
    const issued = await ensureDeviceToken({
      deviceId: identity.deviceId,
      role: "operator",
      scopes: [...SCOPES],
      issuer: { kind: "shared-gateway-auth", generation },
    });
    if (!issued) {
      throw new Error("Fixture device token was not issued");
    }
    deviceToken = issued.token;

    const logger = createSubsystemLogger("test/remote-control-ui-ingress");
    const requestContext = createGatewayWsTestRequestContext();
    const preauthConnectionBudget = createPreauthConnectionBudget(8);
    attachGatewayWsConnectionHandler({
      wss,
      clients,
      connectionWork,
      preauthConnectionBudget,
      bootId: "remote-control-ui-test-boot",
      port: 0,
      getResolvedAuth: () => auth,
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      refreshHealthSnapshot: async () => ({
        ok: true,
        ts: 1,
        durationMs: 0,
        channels: {},
        channelOrder: [],
        channelLabels: {},
        heartbeatSeconds: 0,
        agents: [],
        sessions: { path: "", count: 0, recent: [] },
      }),
      logGateway: logger,
      logHealth: logger,
      logWsControl: logger,
      broadcast: requestContext.broadcast,
      buildRequestContext: () => requestContext as never,
    });
    http = createGatewayHttpRequestHandler({
      clients,
      controlUiEnabled: true,
      controlUiBasePath: "/claw",
      controlUiRoot: { kind: "resolved", path: root },
      resolvedAuth: auth,
      getResolvedAuth: () => auth,
      getRuntimeConfig: () => config,
      handleHooksRequest: async () => false,
    });
    factory = createGatewayControlUiIngressFactory({
      pluginId: "synthetic-bundled-plugin",
      signal: serviceLifetime.signal,
      assertCurrent: () => serviceLifetime.signal.throwIfAborted(),
      host: {
        controlUiBasePath: "/claw",
        getResolvedAuth: () => auth,
        getRuntimeConfig: () => config,
        handleRequest: http,
        handleUpgrade: attachGatewayUpgradeHandler({
          httpServer: upgradeServer,
          wss,
          clients,
          preauthConnectionBudget,
          resolvedAuth: auth,
          getResolvedAuth: () => auth,
          controlUiBasePath: "/claw",
        }),
        handleSandboxRequest: createSandboxHostHttpRequestHandler(),
        signal: hostLifetime.signal,
      },
    });
  });

  afterAll(async () => {
    await ingress?.close();
    hostLifetime.abort();
    serviceLifetime.abort();
    await connectionWork.drain();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    http?.dispose();
    upgradeServer.removeAllListeners();
    await state?.cleanup();
  });

  it("loads the UI and admits a signed paired device while refusing browser shared credentials and unauthenticated hosts", async () => {
    ingress = await factory.open(openOptions);
    const pairingBefore = await listDevicePairing();
    const bootstrapBefore = loadDeviceBootstrapTokenRecords();
    await expect(
      ingress.issuePairingBootstrap({
        deviceId: freshIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(freshIdentity.publicKeyPem),
        displayName: "Fresh synthetic browser",
        scopes: ["operator.read"],
        signal: grantLifetime.signal,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(ingress.cancelPairingBootstrap("synthetic-enrollment")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await listDevicePairing()).toEqual(pairingBefore);
    expect(loadDeviceBootstrapTokenRecords()).toEqual(bootstrapBefore);
    for (const [pathname, expected] of [
      ["/claw/", "Remote UI fixture"],
      ["/claw/assets/app.js", 'document.body.dataset.ready = "remote-ui";'],
    ]) {
      const { response } = await ingress.request({
        surface: "control-ui",
        method: "GET",
        pathAndQuery: pathname!,
        headers: [],
        signal: grantLifetime.signal,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(expected);
    }

    // A real existing auto-approval bootstrap must not become a remote enrollment fallback.
    const genericBootstrap = await issueDeviceBootstrapToken({
      profile: { purpose: "control-ui", roles: ["operator"], scopes: [...SCOPES] },
    });
    for (const credential of ["paired-device", "shared-token", "generic-bootstrap"] as const) {
      const { socket } = await ingress.openWebSocket({
        pathAndQuery: "/claw",
        origin: PUBLIC_ORIGIN,
        protocols: [],
        signal: grantLifetime.signal,
      });
      const messages = socket.messages[Symbol.asyncIterator]();
      try {
        const challenge = await readFrame(messages);
        expect(challenge.event).toBe("connect.challenge");
        const nonce = challenge.payload?.nonce;
        if (!nonce) {
          throw new Error("Missing device challenge nonce");
        }
        const signedAt = Date.now();
        const signingIdentity = credential === "generic-bootstrap" ? freshIdentity : identity;
        const token =
          credential === "paired-device"
            ? deviceToken
            : credential === "generic-bootstrap"
              ? genericBootstrap.token
              : SHARED_TOKEN;
        const payload = buildDeviceAuthPayloadV3({
          deviceId: signingIdentity.deviceId,
          clientId: CLIENT.id,
          clientMode: CLIENT.mode,
          platform: CLIENT.platform,
          role: "operator",
          scopes: [...SCOPES],
          signedAtMs: signedAt,
          token,
          nonce,
        });
        await socket.send({
          kind: "text",
          text: JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: CLIENT,
              role: "operator",
              scopes: [...SCOPES],
              auth:
                credential === "paired-device"
                  ? { deviceToken: token }
                  : credential === "generic-bootstrap"
                    ? { bootstrapToken: token }
                    : { token },
              device: {
                id: signingIdentity.deviceId,
                publicKey: publicKeyRawBase64UrlFromPem(signingIdentity.publicKeyPem),
                signature: signDevicePayload(signingIdentity.privateKeyPem, payload),
                signedAt,
                nonce,
              },
            },
          }),
        });
        const response = await readFrame(messages);
        expect(response.id).toBe("connect");
        if (credential === "paired-device") {
          expect(response.ok).toBe(true);
          expect(response.payload).toMatchObject({
            type: "hello-ok",
            auth: {
              method: "device-token",
              role: "operator",
              scopes: [...SCOPES],
            },
          });
        } else {
          expect(response.ok).toBe(false);
          expect(response.error).toMatchObject({ code: "FORBIDDEN" });
          expect(response.error?.message).toContain("shared Gateway credentials");
        }
      } finally {
        socket.close();
        await socket.closed;
        await messages.return?.();
      }
    }
    const pairingAfter = await listDevicePairing();
    expect(pairingAfter.pending).toEqual([]);
    expect(pairingAfter.paired.some((device) => device.deviceId === freshIdentity.deviceId)).toBe(
      false,
    );
    await ingress.close();
    auth = { mode: "none", allowTailscale: false };
    config = { ...config, gateway: { ...config.gateway, auth: { mode: "none" } } };
    setRuntimeConfigSnapshot(config, config);
    await expect(factory.open(openOptions)).rejects.toMatchObject({
      name: GatewayControlUiIngressError.name,
      code: "unsupported-auth",
      message: expect.stringContaining("token or password"),
    });
  });
});
