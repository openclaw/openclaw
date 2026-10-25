// Real signed node connects protect same-install classification and version admission.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  approveNodePairing,
  listNodePairing,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { configureNodeHost } from "../node-host/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewayVersion = resolveRuntimeServiceVersion(process.env);
const pairingScopes = { callerScopes: ["operator.pairing", "operator.write"] };
const nodePlatform = { platform: "macos", deviceFamily: "Mac" };
const stopClient = (client: Awaited<ReturnType<typeof connectGatewayClient>>) =>
  client.stopAndWait({ timeoutMs: 2_000 });

describe("node host version mismatch guard", () => {
  let port: number;
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  let localIdentity: DeviceIdentity;
  let instanceId: string;

  async function pairSurface(identity: DeviceIdentity, commands: string[] = []) {
    const { request } = await requestNodePairing({
      nodeId: identity.deviceId,
      ...nodePlatform,
      commands,
    });
    return approveNodePairing(request.requestId, pairingScopes);
  }

  async function pairNode(identity: DeviceIdentity) {
    const request = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
      ...nodePlatform,
    });
    const approved = await approveDevicePairing(request.request.requestId, { callerScopes: [] });
    expect(approved?.status).toBe("approved");
    const node = await pairSurface(identity);
    expect(node && "node" in node).toBe(true);
  }

  function connectNode(overrides: Partial<Parameters<typeof connectGatewayClient>[0]> = {}) {
    return connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node",
      clientVersion: gatewayVersion,
      instanceId,
      ...nodePlatform,
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
      deviceIdentity: localIdentity,
      ...overrides,
    });
  }

  async function pendingNode() {
    return (await listNodePairing()).pending.find(
      (entry) => entry.nodeId === localIdentity.deviceId,
    );
  }

  beforeAll(async () => {
    const config = await configureNodeHost({ fallbackDisplayName: "test-node", gateway: {} });
    instanceId = config.nodeId;
    localIdentity = loadOrCreateDeviceIdentity();
    expect(instanceId).not.toBe(localIdentity.deviceId);
    await pairNode(localIdentity);
    const started = await startServer("secret");
    port = started.port;
    server = started.server;
  });

  afterAll(async () => {
    await server?.close();
  });

  test.each([
    [gatewayVersion, "dev"],
    ["2026.9.4", "2026.9.5"],
  ])(
    "Gateway %s accepts same-install node version %s",
    async (serverVersion, clientVersion) =>
      await withEnvAsync({ OPENCLAW_VERSION: serverVersion }, async () => {
        const onHelloOk = vi.fn();
        const client = await connectNode({ clientVersion, onHelloOk });
        try {
          expect(onHelloOk).toHaveBeenCalledWith(
            expect.objectContaining({ protocol: PROTOCOL_VERSION }),
          );
        } finally {
          await stopClient(client);
        }
      }),
  );

  test("accepts an independently signed stale node despite copied instance metadata", async () => {
    const independent = await createOpenClawTestState({
      label: "node-independent",
      applyEnv: false,
    });
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      const identity = loadOrCreateDeviceIdentity({ env: independent.env });
      expect(identity.deviceId).not.toBe(localIdentity.deviceId);
      await pairNode(identity);
      const onHelloOk = vi.fn();
      client = await connectNode({
        deviceIdentity: identity,
        clientVersion: "2020.1.1",
        onHelloOk,
      });
      expect(onHelloOk).toHaveBeenCalledWith(
        expect.objectContaining({ protocol: PROTOCOL_VERSION }),
      );
    } finally {
      try {
        if (client) {
          await stopClient(client);
        }
      } finally {
        await independent.cleanup();
      }
    }
  });

  test("rejected local reconnects preserve the active node pending reapproval", async () => {
    await pairSurface(localIdentity, ["screen.snapshot"]);

    const upgraded = await connectNode({ commands: ["screen.snapshot", "system.run"] });
    try {
      const onHelloOk = vi.fn();
      const connectReverted = async (clientVersion: string, clientDisplayName: string) =>
        await connectNode({
          clientDisplayName,
          clientVersion,
          onHelloOk,
          instanceId: "reconnect-instance-override",
          commands: ["screen.snapshot"],
          timeoutMs: 5_000,
          timeoutMessage: "expected rejected reconnect",
        }).then(async (client) => {
          await stopClient(client);
          return "connected";
        });
      const pendingBefore = await pendingNode();
      expect(pendingBefore?.commands).toEqual(["screen.snapshot", "system.run"]);

      await expect(connectReverted("2020.1.1", "test-node-reverted-stale")).rejects.toMatchObject({
        code: ErrorCodes.INVALID_REQUEST,
        message: "client version mismatch",
        details: {
          code: ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
          clientVersion: "2020.1.1",
          gatewayVersion,
        },
      });
      expect(onHelloOk).not.toHaveBeenCalled();

      const expectPendingUnchanged = async () => {
        expect(await pendingNode()).toMatchObject({
          requestId: pendingBefore?.requestId,
          commands: ["screen.snapshot", "system.run"],
        });
      };
      await expectPendingUnchanged();

      const originalSend = Reflect.get(WebSocket.prototype, "send");
      let failNextHelloOk = true;
      const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
        this: WebSocket,
        ...args: Parameters<WebSocket["send"]>
      ) {
        if (failNextHelloOk && typeof args[0] === "string" && args[0].includes('"hello-ok"')) {
          failNextHelloOk = false;
          const callback = args.findLast((arg) => typeof arg === "function");
          if (typeof callback === "function") {
            callback(new Error("test hello-ok send failure"));
          }
          return;
        }
        Reflect.apply(originalSend, this, args);
      });
      try {
        await expect(
          connectReverted(gatewayVersion, "test-node-reverted-hello-failure"),
        ).rejects.toThrow(
          /gateway closed(?: during connect)? \(1011\): gateway hello delivery failed/i,
        );
        expect(failNextHelloOk).toBe(false);
      } finally {
        sendSpy.mockRestore();
      }

      await expectPendingUnchanged();
    } finally {
      await stopClient(upgraded);
    }
  });
});
