// Proves node-local exec approval relay through real Gateway WebSockets.
import { existsSync } from "node:fs";
import path from "node:path";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { expect, it, vi } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../../../../src/infra/device-identity.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const TEST_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 20_000;
const NODE_COMMANDS = ["system.execApprovals.get", "system.execApprovals.set"];

type GatewayHandle = QaGatewayChild;
type GatewayEvent = { event?: string; payload?: unknown };
type NodeInvokeFrame = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
};

const request = <T = unknown>(client: GatewayClient, method: string, params: unknown) =>
  client.request<T>(method, params, { timeoutMs: REQUEST_TIMEOUT_MS });

const initialSnapshot = {
  enabled: true,
  hash: "sha256:current",
  baseHash: "sha256:current",
  defaultAction: "deny",
  constraints: {
    baseHashRequired: true,
    defaultAllowAllowed: false,
    broadAllowRulesAllowed: false,
    dangerousAllowRulesAllowed: false,
  },
  rules: [{ pattern: "hostname", action: "allow", enabled: true }],
} as const;

it(
  "relays exact policy snapshots and binds results to the current paired connection",
  { timeout: TEST_TIMEOUT_MS },
  async ({ onTestFinished }) => {
    const gatewayOwner = createQaGatewayChild();
    onTestFinished(() => stopQaGatewayFixture(gatewayOwner));
    const gateway = await gatewayOwner.start({
      repoRoot: process.cwd(),
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      runtimeEnvPatch: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
      mutateConfig: (cfg) => {
        const { plugins: _plugins, ...withoutPlugins } = cfg;
        return {
          ...withoutPlugins,
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
      path: path.join(gateway.tempRoot, "node-exec-approvals.sqlite"),
    });
    const firstInbox = createInvokeInbox();
    const replacementInbox = createInvokeInbox();
    let operator: GatewayClient | undefined;
    let firstNode: GatewayClient | undefined;
    let replacementNode: GatewayClient | undefined;

    try {
      operator = await connectOperator(gateway);
      firstNode = await connectNode({
        gateway,
        identity,
        operator,
        onEvent: (event) => firstInbox.onEvent(event),
      });

      replacementNode = await connectNode({
        gateway,
        identity,
        onEvent: (event) => replacementInbox.onEvent(event),
      });
      await waitForConnectedNode(operator, identity.deviceId, gateway.logs);

      const getResultPromise = request<typeof initialSnapshot>(
        operator,
        "exec.approvals.node.get",
        { nodeId: identity.deviceId },
      );
      const getFrame = await replacementInbox.next();
      expect(getFrame).toMatchObject({
        nodeId: identity.deviceId,
        command: "system.execApprovals.get",
      });
      expect(parseParams(getFrame)).toEqual({});
      expect(firstInbox.seen()).toEqual([]);

      await expect(
        request(firstNode, "node.invoke.result", {
          id: getFrame.id,
          nodeId: identity.deviceId,
          ok: true,
          payloadJSON: JSON.stringify({ enabled: false, message: "stale connection" }),
        }),
      ).rejects.toThrow("node pairing changed before request dispatch");

      await respondToInvoke(replacementNode, getFrame, initialSnapshot);
      await expect(getResultPromise).resolves.toEqual(initialSnapshot);

      const nextPolicy = {
        defaultAction: "prompt" as const,
        rules: [
          {
            pattern: "git status",
            action: "allow" as const,
            shells: ["powershell"],
            enabled: true,
          },
        ],
      };
      const setResultPromise = request<{ hash: string; updated: boolean }>(
        operator,
        "exec.approvals.node.set",
        {
          nodeId: identity.deviceId,
          native: nextPolicy,
          baseHash: initialSnapshot.baseHash,
        },
      );
      const setFrame = await replacementInbox.next();
      expect(setFrame).toMatchObject({
        nodeId: identity.deviceId,
        command: "system.execApprovals.set",
      });
      expect(parseParams(setFrame)).toEqual({
        ...nextPolicy,
        baseHash: initialSnapshot.baseHash,
      });
      const updated = { updated: true, hash: "sha256:next" };
      await respondToInvoke(replacementNode, setFrame, updated);
      await expect(setResultPromise).resolves.toEqual(updated);

      const invalidGetPromise = request(operator, "exec.approvals.node.get", {
        nodeId: identity.deviceId,
      });
      const invalidGetRejected = expect(invalidGetPromise).rejects.toThrow(
        "node returned invalid exec approvals payload",
      );
      const invalidGetFrame = await replacementInbox.next();
      await respondToInvoke(replacementNode, invalidGetFrame, {
        enabled: true,
        hash: "sha256:invalid",
        rules: [],
      });
      await invalidGetRejected;
    } finally {
      await Promise.allSettled([
        ...(replacementNode ? [replacementNode.stopAndWait({ timeoutMs: 1_000 })] : []),
        ...(firstNode ? [firstNode.stopAndWait({ timeoutMs: 1_000 })] : []),
        ...(operator ? [operator.stopAndWait({ timeoutMs: 1_000 })] : []),
      ]);
      const tempRoot = gateway.tempRoot;
      await gateway.stop();
      expect(existsSync(tempRoot)).toBe(false);
    }
  },
);

async function connectOperator(gateway: GatewayHandle): Promise<GatewayClient> {
  return await connectClient(gateway, {
    role: "operator",
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Gateway node approval QA operator",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
    deviceIdentity: null,
  });
}

async function connectNode(params: {
  gateway: GatewayHandle;
  identity: DeviceIdentity;
  operator?: GatewayClient;
  onEvent: (event: GatewayEvent) => void;
}): Promise<GatewayClient> {
  const connect = () =>
    connectClient(params.gateway, {
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "Windows exec approval node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      platform: "windows",
      deviceFamily: "Windows",
      scopes: [],
      caps: ["system"],
      commands: NODE_COMMANDS,
      deviceIdentity: params.identity,
      onEvent: params.onEvent,
    });
  try {
    return await connect();
  } catch (error) {
    if (!params.operator || !isPairingRequired(error)) {
      throw error;
    }
    await approvePendingNodePairing(params.operator, params.identity.deviceId);
    return await connect();
  }
}

async function connectClient(
  gateway: GatewayHandle,
  options: Parameters<typeof acquireGatewayTestClient>[0],
): Promise<GatewayClient> {
  return await acquireGatewayTestClient(
    {
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      clientVersion: "1.0.0",
      platform: process.platform,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      ...options,
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
  type Pending = { requestId?: string; deviceId?: string; nodeId?: string; role?: string };
  const waitPending = async (method: string, matches: (entry: Pending) => boolean) => {
    let requestId: string | undefined;
    await vi.waitFor(
      async () => {
        const result = await request<{ pending?: Pending[] }>(operator, method, {});
        requestId = result.pending?.find(matches)?.requestId;
        expect(requestId).toBeTruthy();
      },
      { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
    );
    return requestId;
  };
  const deviceRequestId = await waitPending(
    "device.pair.list",
    (entry) => entry.deviceId === nodeId || entry.role === "node",
  );
  await request(operator, "device.pair.approve", { requestId: deviceRequestId });
  const nodeRequestId = await waitPending("node.pair.list", (entry) => entry.nodeId === nodeId);
  const approval = await approveNodeRequest(operator, nodeId, nodeRequestId);
  expect(approval).toMatchObject({ requestId: nodeRequestId });
}

async function approveNodeRequest(operator: GatewayClient, nodeId: string, requestId?: string) {
  const approval = await request<{ node: unknown }>(operator, "node.pair.approve", { requestId });
  expect(approval.node).toMatchObject({
    nodeId,
    commands: NODE_COMMANDS,
    approvedAtMs: expect.any(Number),
  });
  return approval;
}

async function waitForConnectedNode(
  operator: GatewayClient,
  nodeId: string,
  logs: () => string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      await approvePendingNodeSurface(operator, nodeId);
      const result = await request<{
        nodes?: Array<{
          nodeId?: string;
          connected?: boolean;
          paired?: boolean;
          commands?: string[];
        }>;
      }>(operator, "node.list", {});
      expect(
        result.nodes?.find((entry) => entry.nodeId === nodeId),
        logs(),
      ).toMatchObject({
        nodeId,
        connected: true,
        paired: true,
        commands: NODE_COMMANDS,
      });
    },
    { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
  );
}

async function approvePendingNodeSurface(operator: GatewayClient, nodeId: string): Promise<void> {
  const nodes = await request<{
    pending?: Array<{ requestId?: string; nodeId?: string }>;
  }>(operator, "node.pair.list", {});
  for (const pending of nodes.pending ?? []) {
    if (pending.nodeId !== nodeId || !pending.requestId) {
      continue;
    }
    await approveNodeRequest(operator, nodeId, pending.requestId);
  }
}

function createInvokeInbox() {
  const frames: NodeInvokeFrame[] = [];
  const waiters: Array<(frame: NodeInvokeFrame) => void> = [];
  return {
    onEvent(event: GatewayEvent) {
      if (event.event !== "node.invoke.request") {
        return;
      }
      const frame = parseInvokeFrame(event.payload);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        frames.push(frame);
      }
    },
    async next(): Promise<NodeInvokeFrame> {
      const frame = frames.shift();
      if (frame) {
        return frame;
      }
      return await new Promise<NodeInvokeFrame>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for node.invoke.request")),
          REQUEST_TIMEOUT_MS,
        );
        timeout.unref();
        waiters.push((nextFrame) => {
          clearTimeout(timeout);
          resolve(nextFrame);
        });
      });
    },
    seen(): readonly NodeInvokeFrame[] {
      return frames;
    },
  };
}

function parseInvokeFrame(payload: unknown): NodeInvokeFrame {
  if (!payload || typeof payload !== "object") {
    throw new Error(`invalid node.invoke.request: ${JSON.stringify(payload)}`);
  }
  const frame = payload as Partial<NodeInvokeFrame>;
  if (!frame.id || !frame.nodeId || !frame.command) {
    throw new Error(`invalid node.invoke.request: ${JSON.stringify(payload)}`);
  }
  return {
    id: frame.id,
    nodeId: frame.nodeId,
    command: frame.command,
    paramsJSON: frame.paramsJSON,
  };
}

function parseParams(frame: NodeInvokeFrame): unknown {
  return frame.paramsJSON ? JSON.parse(frame.paramsJSON) : undefined;
}

async function respondToInvoke(
  node: GatewayClient,
  frame: NodeInvokeFrame,
  payload: unknown,
): Promise<void> {
  await request(node, "node.invoke.result", {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: true,
    payloadJSON: JSON.stringify(payload),
  });
}
