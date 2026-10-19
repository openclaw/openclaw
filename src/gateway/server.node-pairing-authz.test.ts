import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  type HelloOk,
  MIN_NODE_PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/index.js";
import {
  approveNodePairing,
  listNodePairing,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { NODE_MCP_TOOLS_CALL_COMMAND } from "../infra/node-commands.js";
import { resolveNodeIdFromNodeList } from "../shared/node-resolve.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { callGateway } from "./call.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
} from "./device-authz.test-helpers.js";
import {
  createNodePairingTestState,
  describeWithGatewayServer,
} from "./server.node-pairing.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const {
  cleanup: cleanupNodePairingTestState,
  makeStateDir: makeNodePairingStateDir,
  seedNodeDevice,
  setup: setupNodePairingTestState,
} = createNodePairingTestState("openclaw-node-pair-authz-");

const pairingScopes = ["operator.pairing", "operator.write"];

function pairNode(name: string, overrides: Partial<Parameters<typeof pairDeviceIdentity>[0]> = {}) {
  return pairDeviceIdentity({
    name,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    ...overrides,
  });
}

function requestMacNode(params: Parameters<typeof requestNodePairing>[0]) {
  return requestNodePairing({ platform: "macos", deviceFamily: "Mac", ...params });
}

type NodeDiagnostics = {
  nodeId: string;
  displayName?: string;
  connected?: boolean;
  commands?: string[];
  approvalState?: string;
  pendingRequestId?: string;
  pendingDeclaredCommands?: string[];
};

async function listNodes(ws: WebSocket) {
  return rpcReq<{ nodes?: NodeDiagnostics[] }>(ws, "node.list", {});
}

async function listPairing(ws: WebSocket) {
  return rpcReq<Awaited<ReturnType<typeof listNodePairing>>>(ws, "node.pair.list", {});
}

async function findPairedNode(nodeId: string, baseDir?: string) {
  const pairing = await listNodePairing(baseDir);
  return pairing.paired.find((node) => node.nodeId === nodeId) ?? null;
}

async function approveSurface(
  params: Parameters<typeof requestMacNode>[0],
  callerScopes = pairingScopes,
) {
  const { request } = await requestMacNode(params);
  return requireApprovedPairing(await approveNodePairing(request.requestId, { callerScopes }));
}

async function pendingNode(nodeId: string) {
  return (await listNodePairing()).pending.find((entry) => entry.nodeId === nodeId);
}

async function pendingDevice(deviceId: string) {
  return (await listDevicePairing()).pending.find((entry) => entry.deviceId === deviceId);
}

function requireApprovedPairing(
  result: Awaited<ReturnType<typeof approveNodePairing>>,
): Exclude<typeof result, null | { status: "forbidden"; missingScope: string }> {
  if (!result || "status" in result) {
    throw new Error(`Expected approved node pairing, got ${JSON.stringify(result)}`);
  }
  return result;
}

async function connectNodeClient(
  port: number,
  deviceIdentity: ReturnType<typeof loadDeviceIdentity>["identity"],
  params: {
    commands?: string[];
    clientName?: GatewayClientName;
    displayName?: string;
    platform?: string;
    deviceFamily?: string;
    caps?: string[];
    permissions?: Record<string, boolean>;
    onHelloOk?: (hello: HelloOk) => void;
    protocol?: "current" | "legacy";
  } = {},
) {
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: "secret",
    role: "node",
    clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: params.displayName ?? "node-command-pin",
    clientVersion: params.protocol === "legacy" ? "2026.5.7" : "1.0.0",
    platform: params.protocol === "legacy" ? "darwin" : (params.platform ?? "macos"),
    deviceFamily: params.protocol === "legacy" ? undefined : (params.deviceFamily ?? "Mac"),
    mode: GATEWAY_CLIENT_MODES.NODE,
    minProtocol: params.protocol === "legacy" ? MIN_NODE_PROTOCOL_VERSION : undefined,
    maxProtocol: params.protocol === "legacy" ? MIN_NODE_PROTOCOL_VERSION : undefined,
    scopes: [],
    caps: params.caps,
    permissions: params.permissions,
    commands: params.commands ?? [],
    deviceIdentity,
    onHelloOk: params.onHelloOk,
    timeoutMessage: "timeout waiting for paired node to connect",
  });
}

async function expectRePairingRequest(params: {
  started: Awaited<ReturnType<typeof startServerWithClient>>;
  pairedName: string;
  initialCommands?: string[];
  reconnectCommands: string[];
  approvalScopes: string[];
  expectedVisibleCommands: string[];
}) {
  const pairedNode = await pairNode(params.pairedName);

  let controlWs: WebSocket | undefined;
  let firstClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    controlWs = await openTrackedWs(params.started.port);
    await connectOk(controlWs, { token: "secret" });

    if (params.initialCommands) {
      firstClient = await connectNodeClient(params.started.port, pairedNode.identity, {
        commands: params.initialCommands,
      });
      await firstClient.stopAndWait();
    }

    const request = await requestMacNode({
      nodeId: pairedNode.identity.deviceId,
      ...(params.initialCommands ? { commands: params.initialCommands } : {}),
    });
    await approveNodePairing(request.request.requestId, {
      callerScopes: params.approvalScopes,
    });

    nodeClient = await connectNodeClient(params.started.port, pairedNode.identity, {
      commands: params.reconnectCommands,
    });
    const connectedControlWs = controlWs;
    const lastNodes = await vi.waitFor(async () => {
      const nodes = (await listNodes(connectedControlWs)).payload?.nodes ?? [];
      const node = nodes.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
      );
      expect(node?.commands?.toSorted()).toEqual(params.expectedVisibleCommands);
      return nodes;
    });
    const pending = await pendingNode(pairedNode.identity.deviceId);
    expect(pending).toMatchObject({
      nodeId: pairedNode.identity.deviceId,
      commands: params.reconnectCommands,
    });
    const listedNode = lastNodes.find((entry) => entry.nodeId === pairedNode.identity.deviceId);
    const expected = {
      approvalState: "pending-reapproval",
      pendingRequestId: pending?.requestId,
      pendingDeclaredCommands: params.reconnectCommands,
      commands: params.expectedVisibleCommands,
    };
    expect(listedNode).toMatchObject(expected);

    const described = await rpcReq<NodeDiagnostics>(controlWs, "node.describe", {
      nodeId: pairedNode.identity.deviceId,
    });
    expect(described.payload).toMatchObject(expected);
  } finally {
    controlWs?.close();
    await firstClient?.stopAndWait();
    await nodeClient?.stopAndWait();
  }
}

async function expectRpcNodePairingApprovalRejected(params: {
  started: Awaited<ReturnType<typeof startServerWithClient>>;
  scope: string;
  missing: string;
  required: string[];
}): Promise<void> {
  const nodeId = `node-rpc-approve-reject-${params.missing}`;
  const missingScope = `operator.${params.missing}`;
  const ws = await openTrackedWs(params.started.port);
  try {
    await connectOk(ws, {
      token: "secret",
      scopes: [`operator.${params.scope}`],
      deviceIdentityPath: `${await makeNodePairingStateDir()}/operator-${params.scope}.sqlite`,
    });
    await seedNodeDevice(nodeId);
    const request = await requestMacNode({ nodeId, commands: ["system.run"] });

    const approve = await rpcReq(ws, "node.pair.approve", {
      requestId: request.request.requestId,
    });

    expect(approve.ok).toBe(false);
    expect(approve.error).toEqual({
      code: "FORBIDDEN",
      message: `missing scope: ${missingScope}`,
      details: {
        code: "MISSING_SCOPE",
        missingScope,
        requiredScopes: params.required,
      },
    });
    await expect(findPairedNode(nodeId)).resolves.toBeNull();
  } finally {
    ws.close();
  }
}

describe("gateway node pairing authorization", () => {
  beforeAll(setupNodePairingTestState);
  afterAll(cleanupNodePairingTestState);

  describeWithGatewayServer("rpc approval scopes", (getStarted) => {
    test.each([
      { scope: "pairing", missing: "admin", required: ["operator.pairing", "operator.admin"] },
      { scope: "write", missing: "pairing", required: ["operator.pairing"] },
    ])("rejects approval with only $scope scope (missing $missing)", async (row) => {
      await expectRpcNodePairingApprovalRejected({ started: getStarted(), ...row });
    });
  });

  describeWithGatewayServer("cross-device management guard", (getStarted) => {
    async function requestVictimNodeSurface(nodeId: string) {
      await seedNodeDevice(nodeId);
      return requestMacNode({ nodeId, commands: [NODE_MCP_TOOLS_CALL_COMMAND] });
    }

    async function openDeviceTokenSession(params: { name: string; scopes: string[] }) {
      const operator = await issueOperatorToken({
        name: params.name,
        approvedScopes: params.scopes,
        tokenScopes: params.scopes,
      });
      const ws = await openTrackedWs(getStarted().port);
      await connectOk(ws, {
        skipDefaultAuth: true,
        deviceToken: operator.token.trim(),
        deviceIdentityPath: operator.identityPath,
        scopes: params.scopes,
      });
      return ws;
    }

    async function approveRenameAndReject(
      ws: WebSocket,
      nodeId: string,
      requestId: string,
      displayName: string,
    ) {
      const approved = await rpcReq(ws, "node.pair.approve", { requestId });
      expect(approved).toMatchObject({
        ok: true,
        payload: { requestId: requestId.trim(), node: { nodeId } },
      });
      await expect(findPairedNode(nodeId)).resolves.toMatchObject({
        commands: [NODE_MCP_TOOLS_CALL_COMMAND],
      });
      expect((await rpcReq(ws, "node.rename", { nodeId, displayName })).ok).toBe(true);
      await expect(findPairedNode(nodeId)).resolves.toMatchObject({ displayName });
      const next = await requestMacNode({
        nodeId,
        commands: [],
      });
      expect((await rpcReq(ws, "node.pair.reject", { requestId: next.request.requestId })).ok).toBe(
        true,
      );
      expect((await listNodePairing()).pending).not.toContainEqual(
        expect.objectContaining({ requestId: next.request.requestId }),
      );
    }

    test("denies non-admin cross-device list, approve, reject, and rename", async () => {
      const approveVictimId = "node-cross-device-approve-victim";
      const approveRequest = await requestVictimNodeSurface(approveVictimId);
      const rejectVictimId = "node-cross-device-reject-victim";
      const rejectRequest = await requestVictimNodeSurface(rejectVictimId);
      const renameVictimId = "node-cross-device-rename-victim";
      const renameRequest = await requestVictimNodeSurface(renameVictimId);
      requireApprovedPairing(
        await approveNodePairing(renameRequest.request.requestId, {
          callerScopes: pairingScopes,
        }),
      );

      const ws = await openDeviceTokenSession({
        name: "node-cross-device-attacker",
        scopes: pairingScopes,
      });
      try {
        const listed = await listPairing(ws);
        expect(listed.ok).toBe(true);
        expect(listed.payload).toEqual({ pending: [], paired: [] });

        for (const [method, requestId, message] of [
          ["approve", approveRequest.request.requestId, "approval"],
          ["reject", rejectRequest.request.requestId, "rejection"],
          ["approve", "unknown-cross-device-approve", "approval"],
          ["reject", "unknown-cross-device-reject", "rejection"],
        ]) {
          expect(await rpcReq(ws, `node.pair.${method}`, { requestId })).toMatchObject({
            ok: false,
            error: { message: `node pairing ${message} denied` },
          });
        }
        await expect(findPairedNode(approveVictimId)).resolves.toBeNull();
        expect((await listNodePairing()).pending).toContainEqual(
          expect.objectContaining({ nodeId: rejectVictimId }),
        );
        expect(
          await rpcReq(ws, "node.rename", {
            nodeId: renameVictimId,
            displayName: "attacker rename",
          }),
        ).toMatchObject({ ok: false, error: { message: "node rename denied" } });
        await expect(findPairedNode(renameVictimId)).resolves.not.toMatchObject({
          displayName: "attacker rename",
        });
      } finally {
        ws.close();
      }
    });

    test.each(["self", "shared", "admin"])("allows %s-auth node management", async (mode) => {
      const name = `node-${mode}-operator`;
      const scopes = mode === "admin" ? ["operator.admin", ...pairingScopes] : pairingScopes;
      const operator = await issueOperatorToken({
        name,
        approvedScopes: scopes,
        ...(mode === "shared" ? {} : { tokenScopes: scopes }),
      });
      const nodeId = mode === "self" ? operator.deviceId : `node-${mode}-victim`;
      if (mode === "self") {
        await pairNode(name);
      } else {
        await seedNodeDevice(nodeId);
      }
      const { request } = await requestMacNode({ nodeId, commands: [NODE_MCP_TOOLS_CALL_COMMAND] });
      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          ...(mode === "shared"
            ? { token: "secret".trim() }
            : { skipDefaultAuth: true, deviceToken: operator.token.trim() }),
          deviceIdentityPath: operator.identityPath,
          scopes,
        });
        const listed = await listPairing(ws);
        if (mode === "self") {
          expect(listed.payload?.pending.map((entry) => entry.nodeId)).toEqual([nodeId]);
        } else {
          expect(listed.payload?.pending).toContainEqual(expect.objectContaining({ nodeId }));
        }
        await approveRenameAndReject(
          ws,
          nodeId,
          mode === "shared" ? `  ${request.requestId}  ` : request.requestId,
          `${mode} renamed`,
        );
      } finally {
        ws.close();
      }
    });

    test("projects an operator rename immediately and after the node reconnects", async () => {
      const pairedNode = await pairNode("node-rename-projection");
      await approveSurface(
        {
          nodeId: pairedNode.identity.deviceId,
          displayName: "Approval Name",
          commands: [],
        },
        ["operator.pairing"],
      );

      const controlWs = await openTrackedWs(getStarted().port);
      let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, { token: "secret" });
        nodeClient = await connectNodeClient(getStarted().port, pairedNode.identity, {
          displayName: "Live Name",
        });

        const renamed = await rpcReq(controlWs, "node.rename", {
          nodeId: pairedNode.identity.deviceId,
          displayName: "Operator Name",
        });
        expect(renamed.ok).toBe(true);

        const readNodes = async () => {
          const listed = await listNodes(controlWs);
          expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
          return listed.payload?.nodes ?? [];
        };
        const readConnectedNode = async () =>
          (await readNodes()).find((entry) => entry.nodeId === pairedNode.identity.deviceId);
        const expected = { displayName: "Operator Name", connected: true };
        expect(await readConnectedNode()).toMatchObject(expected);
        const listedNodes = await readNodes();
        expect(resolveNodeIdFromNodeList(listedNodes, "Operator Name")).toBe(
          pairedNode.identity.deviceId,
        );
        expect(() => resolveNodeIdFromNodeList(listedNodes, "Live Name")).toThrow(
          "unknown node: Live Name",
        );
        const described = await rpcReq<NodeDiagnostics>(controlWs, "node.describe", {
          nodeId: pairedNode.identity.deviceId,
        });
        expect(described.payload).toMatchObject(expected);

        await nodeClient.stopAndWait();
        nodeClient = undefined;
        nodeClient = await connectNodeClient(getStarted().port, pairedNode.identity, {
          displayName: "Replacement Live Name",
        });
        expect(await readConnectedNode()).toMatchObject(expected);
      } finally {
        await nodeClient?.stopAndWait();
        controlWs.close();
      }
    });
  });

  describeWithGatewayServer("paired node reconnects", (getStarted) => {
    test.each(["legacy", "blank"])(
      "normalizes %s desktop metadata without reapproval",
      async (kind) => {
        const name = `node-${kind}-normalization`;
        const pairedNode =
          kind === "legacy"
            ? loadDeviceIdentity(name)
            : await pairNode(name, {
                platform: "macos",
                deviceFamily: "Mac",
              });
        const nodeClient = await connectNodeClient(
          getStarted().port,
          pairedNode.identity,
          kind === "legacy" ? { protocol: "legacy" } : { platform: "darwin", deviceFamily: "   " },
        );
        try {
          expect(await getPairedDevice(pairedNode.identity.deviceId)).toMatchObject({
            platform: "macos",
            deviceFamily: "Mac",
            ...(kind === "legacy"
              ? { clientId: GATEWAY_CLIENT_NAMES.NODE_HOST, clientMode: GATEWAY_CLIENT_MODES.NODE }
              : {}),
          });
          expect(await pendingDevice(pairedNode.identity.deviceId)).toBeUndefined();
        } finally {
          await nodeClient.stopAndWait();
        }
      },
    );

    test("withholds plugin surface URLs until the node capability is approved", async () => {
      // The shared Gateway harness disables Canvas startup; expose its descriptor
      // so this handshake test exercises production capability issuance.
      const previousSkipCanvasHost = process.env.OPENCLAW_SKIP_CANVAS_HOST;
      delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
      try {
        const pairedNode = await pairNode("node-plugin-surface-approval");
        let pendingHello: HelloOk | undefined;
        const pendingClient = await connectNodeClient(getStarted().port, pairedNode.identity, {
          caps: ["canvas"],
          onHelloOk: (hello) => {
            pendingHello = hello;
          },
        });
        await pendingClient.stopAndWait();

        expect(pendingHello?.pluginSurfaceUrls).toBeUndefined();
        const pending = await pendingNode(pairedNode.identity.deviceId);
        expect(pending?.caps).toEqual(["canvas"]);
        requireApprovedPairing(
          await approveNodePairing(pending?.requestId ?? "", {
            callerScopes: ["operator.pairing"],
          }),
        );

        let approvedHello: HelloOk | undefined;
        const approvedClient = await connectNodeClient(getStarted().port, pairedNode.identity, {
          caps: ["canvas"],
          onHelloOk: (hello) => {
            approvedHello = hello;
          },
        });
        try {
          expect(approvedHello?.pluginSurfaceUrls?.canvas).toMatch(
            /^http:\/\/127\.0\.0\.1:\d+\/__openclaw__\/cap\/[^/]+$/,
          );
        } finally {
          await approvedClient.stopAndWait();
        }
      } finally {
        if (previousSkipCanvasHost === undefined) {
          delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
        } else {
          process.env.OPENCLAW_SKIP_CANVAS_HOST = previousSkipCanvasHost;
        }
      }
    });

    test("keeps iOS approval when a transient permission becomes unavailable", async () => {
      const pairedNode = await pairNode("ios-transient-permission", {
        clientId: GATEWAY_CLIENT_NAMES.IOS_APP,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const initialPermissions = { camera: true, watchReachable: true };
      await approveSurface({
        nodeId: pairedNode.identity.deviceId,
        platform: "ios",
        deviceFamily: "iPhone",
        commands: [],
        permissions: initialPermissions,
      });
      const nodeClient = await connectNodeClient(getStarted().port, pairedNode.identity, {
        clientName: GATEWAY_CLIENT_NAMES.IOS_APP,
        displayName: "iPhone",
        platform: "ios",
        deviceFamily: "iPhone",
        permissions: { camera: true, watchReachable: false },
      });
      await nodeClient.stopAndWait();

      expect(await pendingNode(pairedNode.identity.deviceId)).toBeUndefined();
      await expect(findPairedNode(pairedNode.identity.deviceId)).resolves.toMatchObject({
        permissions: initialPermissions,
      });
    });

    test("clears stale reapproval when a node returns to its approved surface", async () => {
      const pairedNode = await pairNode("node-reverted-reapproval");
      await approveSurface({
        nodeId: pairedNode.identity.deviceId,
        commands: ["screen.snapshot"],
      });
      const upgraded = await connectNodeClient(getStarted().port, pairedNode.identity, {
        commands: ["screen.snapshot", "system.run"],
      });
      await upgraded.stopAndWait();
      expect(await pendingNode(pairedNode.identity.deviceId)).toBeDefined();

      const reverted = await connectNodeClient(getStarted().port, pairedNode.identity, {
        commands: ["screen.snapshot"],
      });
      await reverted.stopAndWait();

      await vi.waitFor(async () => {
        expect(await pendingNode(pairedNode.identity.deviceId)).toBeUndefined();
      });
    });

    test("refreshes a paired macOS app node version without a repair request", async () => {
      const pairedNode = await pairNode("macos-version-refresh", {
        clientId: GATEWAY_CLIENT_NAMES.MACOS_APP,

        platform: "macOS 26.5.1",
        deviceFamily: "Mac",
      });
      await approveSurface(
        {
          nodeId: pairedNode.identity.deviceId,
          platform: "macOS 26.5.1",
          deviceFamily: "Mac",
          commands: ["system.info"],
        },
        ["operator.pairing", "operator.write", "operator.admin"],
      );

      const nodeClient = await connectNodeClient(getStarted().port, pairedNode.identity, {
        commands: ["system.info"],
        clientName: GATEWAY_CLIENT_NAMES.MACOS_APP,
        platform: "macOS 26.5.2",
        deviceFamily: "Mac",
      });
      try {
        await vi.waitFor(async () => {
          const pairedDevice = await getPairedDevice(pairedNode.identity.deviceId);
          expect(pairedDevice?.platform).toBe("macOS 26.5.2");
        });
        expect(await pendingDevice(pairedNode.identity.deviceId)).toBeUndefined();
      } finally {
        await nodeClient.stopAndWait();
      }
    });

    test.each([true, false])(
      "requests re-pairing for upgraded commands (initial surface: %s)",
      async (hadCommands) => {
        await expectRePairingRequest({
          started: getStarted(),
          pairedName: hadCommands ? "node-command-pin" : "node-command-empty",
          initialCommands: hadCommands ? ["screen.snapshot"] : undefined,
          reconnectCommands: ["screen.snapshot", "system.run"],
          approvalScopes: hadCommands ? pairingScopes : ["operator.pairing"],
          expectedVisibleCommands: hadCommands ? ["screen.snapshot"] : [],
        });
      },
    );
  });

  describeWithGatewayServer("pending diagnostics scopes", (getStarted) => {
    test("shows pending pairing records to direct-local backend shared-auth callers", async () => {
      const pendingOnlyNodeId = "node-local-backend-pending";
      await seedNodeDevice(pendingOnlyNodeId);
      const pending = await requestNodePairing({
        nodeId: pendingOnlyNodeId,
        platform: "macos",
        commands: ["system.run"],
      });

      const listed = await callGateway<{ nodes?: NodeDiagnostics[] }>({
        config: {
          gateway: {
            mode: "local",
            bind: "loopback",
            port: getStarted().port,
            auth: { mode: "token", token: "secret" },
          },
        },
        method: "node.list",
        scopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
        timeoutMs: 2_000,
      });

      expect(listed.nodes).toContainEqual(
        expect.objectContaining({
          nodeId: pendingOnlyNodeId,
          approvalState: "pending-approval",
          pendingRequestId: pending.request.requestId,
        }),
      );
    });

    test("shows only the caller's pending request id to read-only callers", async () => {
      const pairedNodeId = "node-read-only-paired";
      const visiblePendingNode = await pairDeviceIdentity({
        name: "node-read-only-visible-pending",
        role: "operator",
        scopes: ["operator.read"],
      });
      await pairNode("node-read-only-visible-pending");
      await seedNodeDevice(pairedNodeId);
      await approveSurface({
        nodeId: pairedNodeId,
        platform: "macos",
        deviceFamily: undefined,
        commands: ["screen.snapshot"],
      });
      await requestNodePairing({
        nodeId: pairedNodeId,
        platform: "macos",
        commands: ["screen.snapshot", "system.run"],
      });
      const visiblePending = await requestNodePairing({
        nodeId: visiblePendingNode.identity.deviceId,
        platform: "android",
        commands: ["device.status"],
      });

      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/read-only.sqlite`,
        });

        const listed = await listNodes(ws);
        expect(listed.ok).toBe(true);
        const nodes = listed.payload?.nodes ?? [];
        for (const [nodeId, approvalState] of [
          [pairedNodeId, "pending-reapproval"],
          [visiblePendingNode.identity.deviceId, "pending-approval"],
        ] as const) {
          const described = await rpcReq<NodeDiagnostics>(ws, "node.describe", { nodeId });
          expect(described.ok).toBe(true);
          for (const node of [nodes.find((entry) => entry.nodeId === nodeId), described.payload]) {
            expect(node).toMatchObject({ nodeId, approvalState });
            expect(node).not.toHaveProperty("pendingRequestId");
            expect(node).not.toHaveProperty("pendingDeclaredCommands");
          }
        }

        const selfWs = await openTrackedWs(getStarted().port);
        try {
          await connectOk(selfWs, {
            token: "secret",
            scopes: ["operator.read"],
            deviceIdentityPath: visiblePendingNode.identityPath,
          });
          const selfListed = await listNodes(selfWs);
          const selfNodes = selfListed.payload?.nodes ?? [];
          const expected = {
            approvalState: "pending-approval",
            pendingRequestId: visiblePending.request.requestId,
          };
          expect(
            selfNodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId),
          ).toMatchObject(expected);
          expect(selfNodes.find((node) => node.nodeId === pairedNodeId)).not.toHaveProperty(
            "pendingRequestId",
          );

          const selfDescribed = await rpcReq<NodeDiagnostics>(selfWs, "node.describe", {
            nodeId: visiblePendingNode.identity.deviceId,
          });
          expect(selfDescribed.payload).toMatchObject(expected);
        } finally {
          selfWs.close();
        }
      } finally {
        ws.close();
      }
    });
  });
});
