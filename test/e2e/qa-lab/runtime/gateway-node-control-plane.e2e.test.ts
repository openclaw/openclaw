// Proves the Gateway node control plane across real authenticated WebSockets.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type RawData, WebSocketServer } from "ws";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  ErrorCodes,
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type HelloOk,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../../../../src/infra/device-identity.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  approveControlNodePairing,
  connectControlClient as connectClient,
  connectControlOperator,
  isNodePairingRequired as isPairingRequired,
  startNodeGateway,
} from "./gateway-node-mcp.test-support.js";

const TEST_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 20_000;
const NODE_DISPLAY_NAME = "QA iPhone";
const NODE_CAPS = ["camera", "location"];
const NODE_COMMANDS = ["camera.list", "location.get"];
const NODE_PERMISSIONS = {
  accessibility: true,
  camera: true,
  location: true,
};
const IOS_NODE_OPTIONS = {
  role: "node",
  clientName: GATEWAY_CLIENT_NAMES.IOS_APP,
  clientDisplayName: NODE_DISPLAY_NAME,
  mode: GATEWAY_CLIENT_MODES.NODE,
  platform: "ios",
  deviceFamily: "iPhone",
  scopes: [],
  permissions: NODE_PERMISSIONS,
} satisfies Partial<Parameters<typeof connectClient>[0]>;
const FIXTURE_PLUGIN_ID = "qa-gateway-node-rolling-compat";
const FIXTURE_CAPABILITY = "qa-rolling-surface";
const FIXTURE_COMMAND = "qa.rolling.echo";
const FIXTURE_ROUTE = "/qa-rolling-surface";

type GatewayHandle = QaGatewayChild;
type GatewayConnection = Pick<GatewayHandle, "logs" | "runtimeEnv" | "token" | "wsUrl">;
type NodeRead = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  approvalState?: string;
  paired?: boolean;
  connected?: boolean;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};
type NodeInvokeFrame = {
  id?: string;
  nodeId?: string;
  command?: string;
  paramsJSON?: string | null;
};
type InvocationRecord = {
  id: string;
  nodeId: string;
  command: string;
  params: unknown;
};
type ConnectEnvelope = {
  role: string;
  mode: string;
  clientName: string;
  platform: string;
  deviceFamily?: string;
  minProtocol: number;
  maxProtocol: number;
};
type StoppableClient = Pick<GatewayClient, "stopAndWait">;
type StoppableFixture = {
  stop: () => Promise<void>;
};
const request = <T = unknown>(client: GatewayClient, method: string, params: unknown) =>
  client.request<T>(method, params, { timeoutMs: REQUEST_TIMEOUT_MS });
describe("Gateway node control plane", () => {
  const gatewayOwner = createQaGatewayChild();
  let gateway: GatewayHandle;
  let pluginFixture: Awaited<ReturnType<typeof createFixturePlugin>> | undefined;

  // Pairing and protocol behavior use distinct devices; Gateway startup is not under test.
  beforeAll(async () => {
    const fixture = (pluginFixture = await createFixturePlugin());
    gateway = await startNodeGateway(
      gatewayOwner,
      (cfg) => {
        // This control-plane fixture must not request unrelated QA runtime plugin installs.
        return {
          ...cfg,
          plugins: {
            enabled: true,
            allow: [FIXTURE_PLUGIN_ID],
            slots: { memory: "none" },
            load: { paths: [fixture.pluginDir] },
            entries: { [FIXTURE_PLUGIN_ID]: { enabled: true } },
          },
          gateway: {
            ...cfg.gateway,
            nodes: {
              ...cfg.gateway?.nodes,
              commands: { allow: [...NODE_COMMANDS, FIXTURE_COMMAND] },
            },
          },
        };
      },
      "entry",
    );
  });

  afterAll(async () => {
    await runQaGatewayFixture(
      async () => {
        await stopQaGatewayFixture(gatewayOwner);
        if (gateway) {
          expect(existsSync(gateway.tempRoot)).toBe(false);
        }
      },
      async () => {
        if (pluginFixture) {
          await pluginFixture.cleanup();
          expect(existsSync(pluginFixture.root)).toBe(false);
        }
      },
    );
  });

  it(
    "pairs, inventories, invokes, and records presence for one remote device",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const identity = loadOrCreateDeviceIdentity({
        path: path.join(gateway.tempRoot, "control-plane-node", "client", "credentials.sqlite"),
      });
      const invocations: InvocationRecord[] = [];
      const handlerErrors: Error[] = [];
      const invocationResponses: Promise<void>[] = [];
      let operator: GatewayClient | undefined;
      let node: GatewayClient | undefined;

      try {
        operator = await connectOperator(gateway);
        node = await connectPairedNode({
          gateway,
          identity,
          operator,
          onEvent: (event) => {
            if (event.event !== "node.invoke.request") {
              return;
            }
            const response = respondToInvocation(node, event.payload, invocations).catch(
              (error: unknown) => {
                handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
              },
            );
            invocationResponses.push(response);
          },
        });

        const expectedNode = {
          nodeId: identity.deviceId,
          displayName: NODE_DISPLAY_NAME,
          platform: "ios",
          deviceFamily: "iPhone",
          approvalState: "approved",
          paired: true,
          connected: true,
          permissions: NODE_PERMISSIONS,
        };
        const listed = await waitForApprovedNode(operator, identity.deviceId, gateway.logs);
        const described = await request<NodeRead>(operator, "node.describe", {
          nodeId: identity.deviceId,
        });
        for (const nodeRead of [listed, described]) {
          expect(nodeRead).toMatchObject(expectedNode);
          expect(nodeRead.caps?.toSorted()).toEqual(NODE_CAPS);
          expect(nodeRead.commands?.toSorted()).toEqual(NODE_COMMANDS);
        }

        const probes = [
          {
            command: "camera.list",
            params: { includeUnavailable: false },
            payload: { cameras: [{ id: "back-wide", position: "back" }] },
          },
          {
            command: "location.get",
            params: { accuracy: "balanced" },
            payload: { latitude: 37.3318, longitude: -122.0312 },
          },
        ];
        for (const { command, params, payload } of probes) {
          await expect(
            invokeNodeCommand({
              operator,
              nodeId: identity.deviceId,
              command,
              params,
            }),
          ).resolves.toMatchObject({
            ok: true,
            nodeId: identity.deviceId,
            command,
            payload: { ...payload, received: params },
          });
        }
        expect(invocations).toMatchObject(
          probes.map(({ command, params }) => ({
            nodeId: identity.deviceId,
            command,
            params,
          })),
        );
        await Promise.all(invocationResponses);
        expect(handlerErrors).toEqual([]);

        const aliveSentAtMs = Date.now();
        const aliveResult = await request(node, "node.event", {
          event: "node.presence.alive",
          payload: {
            trigger: "manual",
            sentAtMs: aliveSentAtMs,
            displayName: NODE_DISPLAY_NAME,
            platform: "ios",
            deviceFamily: "iPhone",
          },
        });
        expect(aliveResult).toMatchObject({
          ok: true,
          event: "node.presence.alive",
          handled: true,
          reason: "persisted",
        });

        const connectedOperator = operator;
        await vi.waitFor(
          async () => {
            const afterAlive = await readNode(connectedOperator, identity.deviceId);
            expect(afterAlive, gateway.logs()).toMatchObject({
              lastSeenReason: "manual",
            });
            expect(afterAlive?.lastSeenAtMs).toBeGreaterThanOrEqual(aliveSentAtMs);
            const describedAfterAlive = await request<NodeRead>(
              connectedOperator,
              "node.describe",
              { nodeId: identity.deviceId },
            );
            expect(describedAfterAlive).toMatchObject({
              lastSeenReason: "manual",
            });
            expect(describedAfterAlive.lastSeenAtMs).toBeGreaterThanOrEqual(aliveSentAtMs);
          },
          { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
        );
      } finally {
        await Promise.all(invocationResponses);
        await Promise.allSettled([
          ...(node ? [node.stopAndWait({ timeoutMs: 1_000 })] : []),
          ...(operator ? [operator.stopAndWait({ timeoutMs: 1_000 })] : []),
        ]);
      }
    },
  );

  it(
    "captures the default node protocol envelope with a synthetic v3 overlap fixture",
    { timeout: REQUEST_TIMEOUT_MS * 2 },
    async () => {
      expect(MIN_CLIENT_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
      expect(MIN_NODE_PROTOCOL_VERSION).toBeLessThan(PROTOCOL_VERSION);

      const fixture = await startProtocolEnvelopeFixture();
      let node: GatewayClient | undefined;
      let fixtureHello: HelloOk | undefined;
      try {
        node = await connectClient({
          gateway: fixture.gateway,
          role: "node",
          clientName: GATEWAY_CLIENT_NAMES.IOS_APP,
          clientDisplayName: NODE_DISPLAY_NAME,
          mode: GATEWAY_CLIENT_MODES.NODE,
          platform: "ios",
          deviceFamily: "iPhone",
          scopes: [],
          deviceIdentity: null,
          onHelloOk: (value) => {
            fixtureHello = value;
          },
        });

        // hello.protocol reports the fixture Gateway's current server protocol.
        expect(fixtureHello?.protocol).toBe(MIN_NODE_PROTOCOL_VERSION);
        expect(fixture.connectFrames).toMatchObject([
          {
            role: "node",
            mode: GATEWAY_CLIENT_MODES.NODE,
            minProtocol: MIN_NODE_PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          },
        ]);

        await expect(connectOperator(fixture.gateway)).rejects.toThrow(/protocol mismatch/i);
        expect(fixture.connectFrames).toMatchObject([
          {
            role: "node",
            mode: GATEWAY_CLIENT_MODES.NODE,
            minProtocol: MIN_NODE_PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          },
          {
            role: "operator",
            mode: GATEWAY_CLIENT_MODES.BACKEND,
            minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          },
        ]);
      } finally {
        await stopProtocolEnvelopeFixture(node, fixture);
      }
    },
  );

  it("stops the protocol fixture when client cleanup rejects", async () => {
    const clientError = new Error("client cleanup failed");
    const stopFixture = vi.fn(async () => {});

    await expect(
      stopProtocolEnvelopeFixture(
        {
          stopAndWait: vi.fn(async () => {
            throw clientError;
          }),
        },
        { stop: stopFixture },
      ),
    ).rejects.toBe(clientError);
    expect(stopFixture).toHaveBeenCalledOnce();
  });

  it(
    "reconnects the same paired identity across v3-only and v4 envelopes",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      expect(MIN_NODE_PROTOCOL_VERSION).toBe(3);
      expect(PROTOCOL_VERSION).toBe(4);

      let operator: GatewayClient | undefined;
      let node: GatewayClient | undefined;
      let proofError: unknown;
      const cleanupErrors: unknown[] = [];
      const invocations: InvocationRecord[] = [];
      const handlerErrors: Error[] = [];
      const invocationResponses: Promise<void>[] = [];

      try {
        const identity = loadOrCreateDeviceIdentity({
          path: path.join(gateway.tempRoot, "rolling-compat-node", "client", "credentials.sqlite"),
        });
        const declaredCaps = ["camera", FIXTURE_CAPABILITY];
        const declaredCommands = ["camera.list", FIXTURE_COMMAND];
        const onEvent = (event: { event: string; payload?: unknown }) => {
          if (event.event !== "node.invoke.request") {
            return;
          }
          const response = respondToInvocation(node, event.payload, invocations).catch(
            (error: unknown) => {
              handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
            },
          );
          invocationResponses.push(response);
        };

        operator = await connectOperator(gateway);
        let constrainedHello: HelloOk | undefined;
        node = await connectPairedNode({
          gateway,
          identity,
          operator,
          caps: declaredCaps,
          commands: declaredCommands,
          minProtocol: MIN_NODE_PROTOCOL_VERSION,
          maxProtocol: MIN_NODE_PROTOCOL_VERSION,
          onEvent,
          onHelloOk: (hello) => {
            constrainedHello = hello;
          },
        });

        // The client envelope is constrained to v3; hello reports the v4 server protocol.
        expect(constrainedHello?.protocol).toBe(PROTOCOL_VERSION);
        expect(constrainedHello?.pluginSurfaceUrls).toBeUndefined();
        const legacyListed = await waitForApprovedNode(operator, identity.deviceId, gateway.logs);
        expect(legacyListed.caps).toEqual(["camera"]);
        expect(legacyListed.commands).toEqual(["camera.list"]);

        const cameraParams = { includeUnavailable: false };
        const cameraResult = await invokeNodeCommand({
          operator,
          nodeId: identity.deviceId,
          command: "camera.list",
          params: cameraParams,
        });
        expect(cameraResult).toMatchObject({
          ok: true,
          nodeId: identity.deviceId,
          command: "camera.list",
          payload: {
            cameras: [{ id: "back-wide", position: "back" }],
            received: cameraParams,
          },
        });

        await Promise.all(invocationResponses);
        expect(handlerErrors).toEqual([]);
        await node.stopAndWait({ timeoutMs: 1_000 });
        node = undefined;
        await expectNoPendingPairing(operator, identity.deviceId);

        let currentHello: HelloOk | undefined;
        node = await connectClient({
          ...IOS_NODE_OPTIONS,
          gateway,
          caps: declaredCaps,
          commands: declaredCommands,
          deviceIdentity: identity,
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          onEvent,
          onHelloOk: (hello) => {
            currentHello = hello;
          },
        });

        expect(currentHello?.protocol).toBe(PROTOCOL_VERSION);
        const fixtureSurfaceUrl = currentHello?.pluginSurfaceUrls?.[FIXTURE_CAPABILITY];
        if (!fixtureSurfaceUrl) {
          throw new Error("v4 hello omitted the fixture plugin surface URL");
        }
        expect(new URL(fixtureSurfaceUrl).pathname).toMatch(/^\/__openclaw__\/cap\//);
        const fixtureSurfaceResponse = await fetch(`${fixtureSurfaceUrl}${FIXTURE_ROUTE}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        expect(fixtureSurfaceResponse.status).toBe(204);
        await expectNoPendingPairing(operator, identity.deviceId);
        const currentListed = await waitForApprovedNode(
          operator,
          identity.deviceId,
          gateway.logs,
          false,
        );
        expect(currentListed.caps?.toSorted()).toEqual(declaredCaps.toSorted());
        expect(currentListed.commands?.toSorted()).toEqual(declaredCommands.toSorted());

        const pluginParams = { message: "rolling-compatible" };
        const pluginResult = await invokeNodeCommand({
          operator,
          nodeId: identity.deviceId,
          command: FIXTURE_COMMAND,
          params: pluginParams,
        });
        expect(pluginResult).toMatchObject({
          ok: true,
          nodeId: identity.deviceId,
          command: FIXTURE_COMMAND,
          payload: {
            echoed: pluginParams,
          },
        });
        expect(invocations).toMatchObject([
          {
            nodeId: identity.deviceId,
            command: "camera.list",
            params: cameraParams,
          },
          {
            nodeId: identity.deviceId,
            command: FIXTURE_COMMAND,
            params: pluginParams,
          },
        ]);
        await Promise.all(invocationResponses);
        expect(handlerErrors).toEqual([]);
      } catch (error) {
        proofError = error;
      } finally {
        await Promise.all(invocationResponses);
        const clientCleanup = await Promise.allSettled([
          ...(node ? [node.stopAndWait({ timeoutMs: 1_000 })] : []),
          ...(operator ? [operator.stopAndWait({ timeoutMs: 1_000 })] : []),
        ]);
        for (const result of clientCleanup) {
          if (result.status === "rejected") {
            cleanupErrors.push(result.reason);
          }
        }
      }
      const failures = proofError === undefined ? cleanupErrors : [proofError, ...cleanupErrors];
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "gateway node rolling compatibility proof failed");
      }
    },
  );
});

async function stopProtocolEnvelopeFixture(
  node: StoppableClient | undefined,
  fixture: StoppableFixture,
): Promise<void> {
  const results = await Promise.allSettled([
    ...(node ? [node.stopAndWait({ timeoutMs: 1_000 })] : []),
    fixture.stop(),
  ]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "protocol envelope fixture cleanup failed");
  }
}

const connectOperator = (gateway: GatewayConnection) =>
  connectControlOperator(gateway, "Gateway node QA operator");

async function connectPairedNode(params: {
  gateway: GatewayConnection;
  identity: DeviceIdentity;
  operator: GatewayClient;
  caps?: string[];
  commands?: string[];
  minProtocol?: number;
  maxProtocol?: number;
  onEvent: (event: { event: string; payload?: unknown }) => void;
  onHelloOk?: (hello: HelloOk) => void;
}): Promise<GatewayClient> {
  const connect = () =>
    connectClient({
      ...IOS_NODE_OPTIONS,
      gateway: params.gateway,
      caps: params.caps ?? NODE_CAPS,
      commands: params.commands ?? NODE_COMMANDS,
      deviceIdentity: params.identity,
      minProtocol: params.minProtocol,
      maxProtocol: params.maxProtocol,
      onEvent: params.onEvent,
      onHelloOk: params.onHelloOk,
    });
  try {
    return await connect();
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
    await approveControlNodePairing(params.operator, params.identity.deviceId);
    return await connect();
  }
}

async function waitForApprovedNode(
  operator: GatewayClient,
  nodeId: string,
  logs: () => string,
  approve = true,
): Promise<NodeRead> {
  let approved: NodeRead | undefined;
  await vi.waitFor(
    async () => {
      if (approve) {
        await approvePendingNodeSurface(operator, nodeId);
      }
      approved = await readNode(operator, nodeId);
      expect(approved, logs()).toMatchObject({
        nodeId,
        approvalState: "approved",
        connected: true,
        paired: true,
      });
    },
    { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
  );
  if (!approved) {
    throw new Error(`approved node never became visible:\n${logs()}`);
  }
  return approved;
}

async function approvePendingNodeSurface(operator: GatewayClient, nodeId: string): Promise<void> {
  for (const pending of await readPendingNodePairings(operator)) {
    if (pending.nodeId === nodeId && pending.requestId) {
      await request(operator, "node.pair.approve", { requestId: pending.requestId });
    }
  }
}

async function readPendingNodePairings(
  operator: GatewayClient,
): Promise<Array<{ requestId?: string; nodeId?: string }>> {
  const nodes = await request<{
    pending?: Array<{ requestId?: string; nodeId?: string }>;
  }>(operator, "node.pair.list", {});
  return nodes.pending ?? [];
}

async function expectNoPendingPairing(operator: GatewayClient, nodeId: string): Promise<void> {
  const [devices, nodes] = await Promise.all([
    request<{
      pending?: Array<{ deviceId?: string }>;
    }>(operator, "device.pair.list", {}),
    readPendingNodePairings(operator),
  ]);
  const devicePending = devices.pending?.some((entry) => entry.deviceId === nodeId) ?? false;
  const nodePending = nodes.some((entry) => entry.nodeId === nodeId);
  expect(devicePending).toBe(false);
  expect(nodePending).toBe(false);
}

async function readNode(operator: GatewayClient, nodeId: string): Promise<NodeRead | undefined> {
  const result = await request<{ nodes?: NodeRead[] }>(operator, "node.list", {});
  return result.nodes?.find((entry) => entry.nodeId === nodeId);
}

async function invokeNodeCommand(params: {
  operator: GatewayClient;
  nodeId: string;
  command: string;
  params: unknown;
}): Promise<{
  ok: boolean;
  nodeId: string;
  command: string;
  payload: unknown;
}> {
  return await params.operator.request(
    "node.invoke",
    {
      nodeId: params.nodeId,
      command: params.command,
      params: params.params,
      timeoutMs: REQUEST_TIMEOUT_MS,
      idempotencyKey: randomUUID(),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
}

async function respondToInvocation(
  node: GatewayClient | undefined,
  payload: unknown,
  invocations: InvocationRecord[],
): Promise<void> {
  const frame = payload as NodeInvokeFrame;
  if (!node || !frame.id || !frame.nodeId || !frame.command) {
    throw new Error(`invalid node.invoke.request: ${JSON.stringify(payload)}`);
  }
  const params = frame.paramsJSON ? JSON.parse(frame.paramsJSON) : undefined;
  invocations.push({
    id: frame.id,
    nodeId: frame.nodeId,
    command: frame.command,
    params,
  });
  const response =
    frame.command === "camera.list"
      ? {
          cameras: [{ id: "back-wide", position: "back" }],
          received: params,
        }
      : frame.command === "location.get"
        ? {
            latitude: 37.3318,
            longitude: -122.0312,
            received: params,
          }
        : frame.command === FIXTURE_COMMAND
          ? {
              echoed: params,
            }
          : undefined;
  if (!response) {
    throw new Error(`unexpected node command: ${frame.command}`);
  }
  await node.request(
    "node.invoke.result",
    {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: true,
      payloadJSON: JSON.stringify(response),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
}

async function createFixturePlugin(): Promise<{
  root: string;
  pluginDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-node-rolling-"));
  const pluginDir = path.join(root, FIXTURE_PLUGIN_ID);
  try {
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(
        {
          id: FIXTURE_PLUGIN_ID,
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      `module.exports = {
  id: ${JSON.stringify(FIXTURE_PLUGIN_ID)},
  register(api) {
    api.registerHttpRoute({
      path: ${JSON.stringify(FIXTURE_ROUTE)},
      auth: "plugin",
      nodeCapability: { surface: ${JSON.stringify(FIXTURE_CAPABILITY)} },
      handler(_req, res) {
        res.statusCode = 204;
        res.end();
        return true;
      },
    });
    api.registerNodeInvokePolicy({
      commands: [${JSON.stringify(FIXTURE_COMMAND)}],
      defaultPlatforms: ["ios"],
      handle: async (ctx) => await ctx.invokeNode(),
    });
  },
};\n`,
      "utf8",
    );
    return {
      root,
      pluginDir,
      cleanup: () => fs.rm(root, { force: true, recursive: true }),
    };
  } catch (error) {
    try {
      await fs.rm(root, { force: true, recursive: true });
    } catch (cleanupError) {
      const failure = new AggregateError(
        [error, cleanupError],
        "fixture plugin setup and cleanup failed",
      );
      failure.cause = error;
      throw failure;
    }
    throw error;
  }
}

function parseConnectEnvelope(
  data: RawData,
): { id: string; envelope: ConnectEnvelope } | undefined {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8")
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Buffer.from(data).toString("utf8");
    const frame = JSON.parse(text);
    if (!isRecord(frame) || frame.method !== "connect" || typeof frame.id !== "string") {
      return undefined;
    }
    const params = frame.params;
    if (!isRecord(params) || !isRecord(params.client)) {
      return undefined;
    }
    if (
      typeof params.role !== "string" ||
      typeof params.client.id !== "string" ||
      typeof params.client.mode !== "string" ||
      typeof params.client.platform !== "string" ||
      typeof params.minProtocol !== "number" ||
      typeof params.maxProtocol !== "number"
    ) {
      return undefined;
    }
    return {
      id: frame.id,
      envelope: {
        role: params.role,
        mode: params.client.mode,
        clientName: params.client.id,
        platform: params.client.platform,
        ...(typeof params.client.deviceFamily === "string"
          ? { deviceFamily: params.client.deviceFamily }
          : {}),
        minProtocol: params.minProtocol,
        maxProtocol: params.maxProtocol,
      },
    };
  } catch {
    return undefined;
  }
}

async function startProtocolEnvelopeFixture(): Promise<{
  gateway: GatewayConnection;
  connectFrames: ConnectEnvelope[];
  stop: () => Promise<void>;
}> {
  const connectFrames: ConnectEnvelope[] = [];
  const protocol = MIN_NODE_PROTOCOL_VERSION;
  let challengeSequence = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        seq: 1,
        payload: { nonce: `qa-protocol-envelope-${++challengeSequence}`, ts: Date.now() },
      }),
    );
    socket.on("message", (data) => {
      const connect = parseConnectEnvelope(data);
      if (!connect) {
        return;
      }
      connectFrames.push(connect.envelope);
      const supportsProtocol =
        connect.envelope.minProtocol <= protocol && connect.envelope.maxProtocol >= protocol;
      if (!supportsProtocol) {
        socket.send(
          JSON.stringify({
            type: "res",
            id: connect.id,
            ok: false,
            error: {
              code: ErrorCodes.INVALID_REQUEST,
              message: "protocol mismatch",
              details: {
                code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
                clientMinProtocol: connect.envelope.minProtocol,
                clientMaxProtocol: connect.envelope.maxProtocol,
                expectedProtocol: protocol,
              },
            },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          type: "res",
          id: connect.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol,
            server: { version: `qa-protocol-${protocol}-fixture`, connId: randomUUID() },
            features: { methods: [], events: [] },
            snapshot: {
              presence: [],
              health: {},
              stateVersion: { presence: 1, health: 1 },
              uptimeMs: 1,
            },
            auth: { role: connect.envelope.role, scopes: [] },
            policy: {
              maxPayload: 512 * 1024,
              maxBufferedBytes: 1024 * 1024,
              tickIntervalMs: 30_000,
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("v3 Gateway fixture did not bind a TCP port");
  }
  return {
    connectFrames,
    gateway: {
      wsUrl: `ws://127.0.0.1:${address.port}`,
      token: "qa-v3-gateway-token",
      runtimeEnv: {},
      logs: () => JSON.stringify(connectFrames),
    },
    async stop() {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
