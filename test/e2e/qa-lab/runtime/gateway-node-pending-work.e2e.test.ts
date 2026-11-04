import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { expect, it, vi } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type {
  NodePendingDrainResult,
  NodePendingEnqueueResult,
} from "../../../../packages/gateway-protocol/src/schema/nodes.js";
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../../../../src/infra/device-identity.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const REQUEST_TIMEOUT_MS = 20_000;
const NODE_COMMANDS = ["camera.snap"];

type NodeInvokeFrame = {
  id?: string;
  nodeId?: string;
  command?: string;
  paramsJSON?: string | null;
};
type NodeRead = { nodeId: string };
type PendingAction = {
  id: string;
  command: string;
  paramsJSON: string | null;
  enqueuedAtMs: number;
};

it(
  "delivers disconnected work and foreground-only actions after same-pairing reconnects",
  { timeout: 180_000 },
  async ({ onTestFinished }) => {
    const gatewayOwner = createQaGatewayChild();
    onTestFinished(() => stopQaGatewayFixture(gatewayOwner));
    const gateway = await gatewayOwner.start({
      repoRoot: process.cwd(),
      command: {
        executablePath: process.execPath,
        argsPrefix: ["dist/entry.js"],
        cwd: process.cwd(),
        // Pending-node delivery needs no packaged-install repair.
        usePackagedPlugins: false,
      },
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      runtimeEnvPatch: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
      mutateConfig: (cfg) => {
        return {
          ...cfg,
          plugins: { enabled: false },
          gateway: {
            ...cfg.gateway,
            nodes: {
              ...cfg.gateway?.nodes,
              commands: { allow: NODE_COMMANDS },
            },
          },
        };
      },
    });
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(gateway.tempRoot, "pending-work-node", "client", "credentials.sqlite"),
    });
    const nodeId = identity.deviceId;
    const handlerErrors: Error[] = [];
    const backgroundRequests: NodeInvokeFrame[] = [];
    let operator: GatewayClient | undefined;
    let node: GatewayClient | undefined;

    const waitForConnection = (connected: boolean, approve = false) =>
      waitForNodeConnection(expectConnected(operator), nodeId, connected, gateway.logs, approve);
    const disconnectNode = async () => {
      await node?.stopAndWait({ timeoutMs: 1_000 });
      node = undefined;
      await waitForConnection(false);
    };
    const connectNode = async () => {
      const connected = await connectPairedNode({
        gateway,
        identity,
        operator: expectConnected(operator),
        onEvent: (event) => {
          if (event.event !== "node.invoke.request") {
            return;
          }
          void rejectBackgroundInvocation(node, event.payload, backgroundRequests).catch(
            (error: unknown) => {
              handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
            },
          );
        },
      });
      await waitForConnection(true, true);
      return connected;
    };

    try {
      operator = await connectOperator(gateway);
      node = await connectNode();
      await waitForConnection(true);

      await disconnectNode();

      const work = { type: "location.request", priority: "high" };
      const enqueued = await operator.request<NodePendingEnqueueResult>("node.pending.enqueue", {
        nodeId,
        ...work,
        wake: false,
      });
      expect(enqueued).toMatchObject({
        nodeId,
        queued: work,
        wakeTriggered: false,
      });
      expect(enqueued.queued.id).toBeTruthy();

      node = await connectNode();
      await waitForConnection(true);
      const drained = await node.request<NodePendingDrainResult>("node.pending.drain", {
        maxItems: 2,
      });
      expect(drained).toMatchObject({
        nodeId,
        items: [
          { id: enqueued.queued.id, ...work },
          {
            id: "baseline-status",
            type: "status.request",
            priority: "default",
          },
        ],
        hasMore: false,
      });

      const cameraParams = { facing: "back", maxWidth: 1280 };
      const cameraAction = { command: "camera.snap", paramsJSON: JSON.stringify(cameraParams) };
      let invokeError: unknown;
      try {
        await operator.request("node.invoke", {
          nodeId,
          command: "camera.snap",
          params: cameraParams,
          timeoutMs: REQUEST_TIMEOUT_MS,
          idempotencyKey: randomUUID(),
        });
      } catch (error) {
        invokeError = error;
      }
      expect(invokeError).toMatchObject({
        code: "UNAVAILABLE",
        retryable: true,
        details: {
          code: "QUEUED_UNTIL_FOREGROUND",
          nodeId,
          command: "camera.snap",
        },
      });
      const queuedActionId = readQueuedActionId(invokeError);
      expect(backgroundRequests).toMatchObject([{ nodeId, ...cameraAction }]);
      expect(handlerErrors).toEqual([]);

      await disconnectNode();
      node = await connectNode();
      await waitForConnection(true);

      const pulled = await node.request<{
        nodeId: string;
        actions: PendingAction[];
      }>("node.pending.pull", {});
      expect(pulled).toMatchObject({
        nodeId,
        actions: [{ id: queuedActionId, ...cameraAction, enqueuedAtMs: expect.any(Number) }],
      });

      const acked = await node.request<{
        nodeId: string;
        ackedIds: string[];
        remainingCount: number;
      }>("node.pending.ack", { ids: [queuedActionId] });
      expect(acked).toEqual({
        nodeId,
        ackedIds: [queuedActionId],
        remainingCount: 0,
      });
      await expect(
        node.request<{ nodeId: string; actions: PendingAction[] }>("node.pending.pull", {}),
      ).resolves.toEqual({
        nodeId,
        actions: [],
      });
    } finally {
      await Promise.allSettled([
        ...(node ? [node.stopAndWait({ timeoutMs: 1_000 })] : []),
        ...(operator ? [operator.stopAndWait({ timeoutMs: 1_000 })] : []),
      ]);
      await gateway.stop();
      expect(existsSync(gateway.tempRoot)).toBe(false);
    }
  },
);

function expectConnected(client: GatewayClient | undefined): GatewayClient {
  if (!client) {
    throw new Error("operator is not connected");
  }
  return client;
}

async function connectOperator(gateway: QaGatewayChild): Promise<GatewayClient> {
  return await connectClient({
    gateway,
    role: "operator",
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Gateway pending-work QA operator",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
    deviceIdentity: null,
  });
}

async function connectPairedNode(params: {
  gateway: QaGatewayChild;
  identity: DeviceIdentity;
  operator: GatewayClient;
  onEvent: (event: { event: string; payload?: unknown }) => void;
}): Promise<GatewayClient> {
  const connect = () =>
    connectClient({
      gateway: params.gateway,
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.IOS_APP,
      clientDisplayName: "QA iPad",
      mode: GATEWAY_CLIENT_MODES.NODE,
      platform: "iPadOS 26.4",
      deviceFamily: "iPad",
      scopes: [],
      caps: ["camera"],
      commands: NODE_COMMANDS,
      permissions: { camera: true },
      deviceIdentity: params.identity,
      onEvent: params.onEvent,
    });
  try {
    return await connect();
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
    await approvePendingNodePairing(params.operator, params.identity.deviceId);
    return await connect();
  }
}

async function connectClient(
  params: { gateway: QaGatewayChild } & Omit<
    Parameters<typeof acquireGatewayTestClient>[0],
    "url" | "token" | "env" | "onHelloOk" | "onClose"
  >,
): Promise<GatewayClient> {
  const { gateway, ...options } = params;
  return acquireGatewayTestClient(
    {
      ...options,
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      clientVersion: "1.0.0",
      platform: options.platform ?? process.platform,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      timeoutMessage: `Gateway client connection timed out:\n${gateway.logs()}`,
      closeMessage: "Gateway closed",
      unrefTimeout: true,
    },
  );
}

function isPairingRequired(error: unknown): boolean {
  const details =
    error && typeof error === "object"
      ? (error as { details?: { code?: unknown } }).details
      : undefined;
  return details?.code === "PAIRING_REQUIRED" || String(error).includes("PAIRING_REQUIRED");
}

async function approvePendingNodePairing(operator: GatewayClient, nodeId: string): Promise<void> {
  for (const kind of ["device", "node"] as const) {
    let requestId: string | undefined;
    await vi.waitFor(
      async () => {
        const { pending } = await operator.request<{
          pending?: Array<{
            requestId?: string;
            deviceId?: string;
            nodeId?: string;
            role?: string;
          }>;
        }>(`${kind}.pair.list`, {});
        const entry = pending?.find((candidate) =>
          kind === "device"
            ? candidate.deviceId === nodeId || candidate.role === "node"
            : candidate.nodeId === nodeId,
        );
        expect(entry?.requestId).toBeTruthy();
        requestId = entry?.requestId;
      },
      { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
    );
    await operator.request(`${kind}.pair.approve`, { requestId });
  }
}

async function waitForNodeConnection(
  operator: GatewayClient,
  nodeId: string,
  connected: boolean,
  logs: () => string,
  approve = false,
): Promise<void> {
  await vi.waitFor(
    async () => {
      if (approve) {
        await approvePendingNodeSurface(operator, nodeId);
      }
      const result = await operator.request<{ nodes?: NodeRead[] }>("node.list", {});
      expect(
        result.nodes?.find((entry) => entry.nodeId === nodeId),
        logs(),
      ).toMatchObject({
        nodeId,
        paired: true,
        connected,
        ...(approve ? { approvalState: "approved" } : {}),
      });
    },
    { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
  );
}

async function approvePendingNodeSurface(operator: GatewayClient, nodeId: string): Promise<void> {
  const nodes = await operator.request<{
    pending?: Array<{ requestId?: string; nodeId?: string }>;
  }>("node.pair.list", {});
  for (const pending of nodes.pending ?? []) {
    if (pending.nodeId === nodeId && pending.requestId) {
      await operator.request("node.pair.approve", { requestId: pending.requestId });
    }
  }
}

async function rejectBackgroundInvocation(
  node: GatewayClient | undefined,
  payload: unknown,
  requests: NodeInvokeFrame[],
): Promise<void> {
  const frame = payload as NodeInvokeFrame;
  if (!node || !frame.id || !frame.nodeId || !frame.command) {
    throw new Error(`invalid node.invoke.request: ${JSON.stringify(payload)}`);
  }
  requests.push(frame);
  await node.request("node.invoke.result", {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: false,
    error: {
      code: "NODE_BACKGROUND_UNAVAILABLE",
      message: "NODE_BACKGROUND_UNAVAILABLE: camera commands require foreground",
    },
  });
}

function readQueuedActionId(error: unknown): string {
  const details =
    error && typeof error === "object"
      ? (error as { details?: { queuedActionId?: unknown } }).details
      : undefined;
  if (typeof details?.queuedActionId !== "string" || details.queuedActionId.length === 0) {
    throw new Error(`queued action id missing from invoke error: ${String(error)}`);
  }
  return details.queuedActionId;
}
