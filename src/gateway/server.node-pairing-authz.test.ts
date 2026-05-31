import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  approveNodePairing,
  getPairedNode,
  listNodePairing,
  requestNodePairing,
} from "../infra/node-pairing.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
} from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-pair-authz-" });

async function makeNodePairingStateDir(): Promise<string> {
  return await tempDirs.make("case");
}

function requireApprovedPairing(
  result: Awaited<ReturnType<typeof approveNodePairing>>,
): Exclude<typeof result, null | { status: "forbidden"; missingScope: string }> {
  if (!result || "status" in result) {
    throw new Error(`Expected approved node pairing, got ${JSON.stringify(result)}`);
  }
  return result;
}

async function connectNodeClient(params: {
  port: number;
  deviceIdentity: ReturnType<typeof loadDeviceIdentity>["identity"];
  commands: string[];
  instanceId?: string;
}) {
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token: "secret",
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: "node-command-pin",
    clientVersion: "1.0.0",
    platform: "macos",
    deviceFamily: "Mac",
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: params.instanceId,
    scopes: [],
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
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
  const pairedNode = await pairDeviceIdentity({
    name: params.pairedName,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });

  let controlWs: WebSocket | undefined;
  let firstClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    controlWs = await openTrackedWs(params.started.port);
    await connectOk(controlWs, { token: "secret" });

    if (params.initialCommands) {
      firstClient = await connectNodeClient({
        port: params.started.port,
        deviceIdentity: pairedNode.identity,
        commands: params.initialCommands,
      });
      await firstClient.stopAndWait();
    }

    const request = await requestNodePairing({
      nodeId: pairedNode.identity.deviceId,
      platform: "macos",
      deviceFamily: "Mac",
      ...(params.initialCommands ? { commands: params.initialCommands } : {}),
    });
    await approveNodePairing(request.request.requestId, {
      callerScopes: params.approvalScopes,
    });

    nodeClient = await connectNodeClient({
      port: params.started.port,
      deviceIdentity: pairedNode.identity,
      commands: params.reconnectCommands,
    });
    const connectedControlWs = controlWs;

    let lastNodes: Array<{ nodeId: string; connected?: boolean; commands?: string[] }> = [];
    await vi.waitFor(async () => {
      const list = await rpcReq<{
        nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
      }>(connectedControlWs, "node.list", {});
      lastNodes = list.payload?.nodes ?? [];
      const node = lastNodes.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
      );
      if (
        JSON.stringify(node?.commands?.toSorted() ?? []) ===
        JSON.stringify(params.expectedVisibleCommands)
      ) {
        return;
      }
      throw new Error(`node commands not visible yet: ${JSON.stringify(lastNodes)}`);
    });

    expect(
      lastNodes
        .find((entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected)
        ?.commands?.toSorted(),
      JSON.stringify(lastNodes),
    ).toEqual(params.expectedVisibleCommands);

    const pairing = await listNodePairing();
    const pending = pairing.pending?.find((entry) => entry.nodeId === pairedNode.identity.deviceId);
    expect(pending?.nodeId).toBe(pairedNode.identity.deviceId);
    expect(pending?.commands).toEqual(params.reconnectCommands);
  } finally {
    controlWs?.close();
    await firstClient?.stopAndWait();
    await nodeClient?.stopAndWait();
  }
}

describe("gateway node pairing authorization", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  describe("approval scopes", () => {
    test("rejects node pairing approval without admin scope", async () => {
      const baseDir = await makeNodePairingStateDir();
      const request = await requestNodePairing(
        {
          nodeId: "node-approve-reject-admin",
          platform: "macos",
          deviceFamily: "Mac",
          commands: ["system.run"],
        },
        baseDir,
      );

      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      ).resolves.toEqual({
        status: "forbidden",
        missingScope: "operator.admin",
      });
      await expect(getPairedNode("node-approve-reject-admin", baseDir)).resolves.toBeNull();
    });

    test("rejects node pairing approval without pairing scope", async () => {
      const baseDir = await makeNodePairingStateDir();
      const request = await requestNodePairing(
        {
          nodeId: "node-approve-reject-pairing",
          platform: "macos",
          deviceFamily: "Mac",
          commands: ["system.run"],
        },
        baseDir,
      );

      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.write"] },
          baseDir,
        ),
      ).resolves.toEqual({
        status: "forbidden",
        missingScope: "operator.pairing",
      });
      await expect(getPairedNode("node-approve-reject-pairing", baseDir)).resolves.toBeNull();
    });

    test("approves commandless node pairing with pairing scope", async () => {
      const baseDir = await makeNodePairingStateDir();
      const request = await requestNodePairing(
        {
          nodeId: "node-approve-target",
          platform: "macos",
          deviceFamily: "Mac",
        },
        baseDir,
      );

      const approved = requireApprovedPairing(
        await approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      );
      expect(approved.requestId).toBe(request.request.requestId);
      expect(approved.node.nodeId).toBe("node-approve-target");

      const pairedNode = await getPairedNode("node-approve-target", baseDir);
      expect(pairedNode?.nodeId).toBe("node-approve-target");
    });
  });

  describe("rpc approval scopes", () => {
    let started: Awaited<ReturnType<typeof startServerWithClient>>;

    beforeAll(async () => {
      started = await startServerWithClient("secret");
    });

    afterAll(async () => {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    });

    test("rejects system.run node pairing approval without admin scope through rpc", async () => {
      const ws = await openTrackedWs(started.port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.pairing"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/operator-pairing.json`,
        });
        const request = await requestNodePairing({
          nodeId: "node-rpc-approve-reject-admin",
          platform: "macos",
          deviceFamily: "Mac",
          commands: ["system.run"],
        });

        const approve = await rpcReq(ws, "node.pair.approve", {
          requestId: request.request.requestId,
        });

        expect(approve.ok).toBe(false);
        expect(approve.error?.message).toContain("missing scope: operator.admin");
        await expect(getPairedNode("node-rpc-approve-reject-admin")).resolves.toBeNull();
      } finally {
        ws.close();
      }
    });

    test("rejects node pairing approval without pairing scope through rpc", async () => {
      const ws = await openTrackedWs(started.port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.write"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/operator-write.json`,
        });
        const request = await requestNodePairing({
          nodeId: "node-rpc-approve-reject-pairing",
          platform: "macos",
          deviceFamily: "Mac",
          commands: ["system.run"],
        });

        const approve = await rpcReq(ws, "node.pair.approve", {
          requestId: request.request.requestId,
        });

        expect(approve.ok).toBe(false);
        expect(approve.error?.message).toContain("operator.pairing");
        await expect(getPairedNode("node-rpc-approve-reject-pairing")).resolves.toBeNull();
      } finally {
        ws.close();
      }
    });
  });

  describe("paired node reconnects", () => {
    let started: Awaited<ReturnType<typeof startServerWithClient>>;

    beforeAll(async () => {
      started = await startServerWithClient("secret");
    });

    afterAll(async () => {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    });

    test("requests re-pairing when a paired node reconnects with upgraded commands", async () => {
      await expectRePairingRequest({
        started,
        pairedName: "node-command-pin",
        initialCommands: ["screen.snapshot"],
        reconnectCommands: ["screen.snapshot", "system.run"],
        approvalScopes: ["operator.pairing", "operator.write"],
        expectedVisibleCommands: ["screen.snapshot"],
      });
    });

    test("requests re-pairing when a commandless paired node reconnects with system.run", async () => {
      await expectRePairingRequest({
        started,
        pairedName: "node-command-empty",
        reconnectCommands: ["screen.snapshot", "system.run"],
        approvalScopes: ["operator.pairing"],
        expectedVisibleCommands: [],
      });
    });

    test("keeps approved commands when a device-token node reconnects with a stable instance id", async () => {
      const pairedDevice = await pairDeviceIdentity({
        name: "node-device-token-rotation",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const stableNodeId = "stable-node-token-rotation";
      const request = await requestNodePairing({
        nodeId: stableNodeId,
        deviceId: pairedDevice.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["system.which"],
      });
      requireApprovedPairing(
        await approveNodePairing(request.request.requestId, {
          callerScopes: ["operator.pairing", "operator.admin"],
        }),
      );

      const controlWs = await openTrackedWs(started.port);
      let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, { token: "secret" });
        nodeClient = await connectNodeClient({
          port: started.port,
          deviceIdentity: pairedDevice.identity,
          instanceId: stableNodeId,
          commands: ["system.which"],
        });

        await vi.waitFor(async () => {
          const list = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
          }>(controlWs, "node.list", {});
          const node = list.payload?.nodes?.find((entry) => entry.nodeId === stableNodeId);
          if (node?.connected && node.commands?.includes("system.which")) {
            return;
          }
          throw new Error(`stable node commands not visible yet: ${JSON.stringify(list.payload)}`);
        });
      } finally {
        controlWs.close();
        await nodeClient?.stopAndWait();
      }
    });

    test("accepts public stable-node approvals when the request carries a verified device id", async () => {
      const pairedDevice = await pairDeviceIdentity({
        name: "node-public-stable-bind",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const stableNodeId = "stable-node-public-approval";
      const request = await requestNodePairing({
        nodeId: stableNodeId,
        deviceId: pairedDevice.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["system.which"],
      });
      requireApprovedPairing(
        await approveNodePairing(request.request.requestId, {
          callerScopes: ["operator.pairing", "operator.admin"],
        }),
      );

      const controlWs = await openTrackedWs(started.port);
      let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, { token: "secret" });
        nodeClient = await connectNodeClient({
          port: started.port,
          deviceIdentity: pairedDevice.identity,
          instanceId: stableNodeId,
          commands: ["system.which"],
        });

        await vi.waitFor(async () => {
          const list = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
          }>(controlWs, "node.list", {});
          const node = list.payload?.nodes?.find((entry) => entry.nodeId === stableNodeId);
          if (node?.connected && node.commands?.includes("system.which")) {
            return;
          }
          throw new Error(
            `public stable node approval not usable yet: ${JSON.stringify(list.payload)}`,
          );
        });
        const pairedStableNode = await getPairedNode(stableNodeId);
        expect(pairedStableNode?.deviceId).toBe(pairedDevice.identity.deviceId);
      } finally {
        controlWs.close();
        await nodeClient?.stopAndWait();
      }
    });

    test("live-updates a first-time stable node when its pending request is approved", async () => {
      const pairedDevice = await pairDeviceIdentity({
        name: "node-first-stable",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const stableNodeId = "stable-node-first-approval";
      const controlWs = await openTrackedWs(started.port);
      let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, {
          token: "secret",
          scopes: ["operator.pairing", "operator.admin"],
        });
        nodeClient = await connectNodeClient({
          port: started.port,
          deviceIdentity: pairedDevice.identity,
          instanceId: stableNodeId,
          commands: ["system.which"],
        });

        const pairing = await listNodePairing();
        const pending = pairing.pending.find((entry) => entry.nodeId === stableNodeId);
        expect(pending?.deviceId).toBe(pairedDevice.identity.deviceId);
        const approve = await rpcReq(controlWs, "node.pair.approve", {
          requestId: pending?.requestId,
        });
        expect(approve.ok).toBe(true);

        await vi.waitFor(async () => {
          const list = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
          }>(controlWs, "node.list", {});
          const node = list.payload?.nodes?.find((entry) => entry.nodeId === stableNodeId);
          if (node?.connected && node.commands?.includes("system.which")) {
            return;
          }
          throw new Error(
            `approved stable node not live-updated yet: ${JSON.stringify(list.payload)}`,
          );
        });
      } finally {
        controlWs.close();
        await nodeClient?.stopAndWait();
      }
    });

    test("keeps legacy device-id approvals registered under the approved node id", async () => {
      const pairedDevice = await pairDeviceIdentity({
        name: "node-legacy-device-id",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const request = await requestNodePairing({
        nodeId: pairedDevice.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["system.which"],
      });
      requireApprovedPairing(
        await approveNodePairing(request.request.requestId, {
          callerScopes: ["operator.pairing", "operator.admin"],
        }),
      );

      const controlWs = await openTrackedWs(started.port);
      let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, { token: "secret" });
        nodeClient = await connectNodeClient({
          port: started.port,
          deviceIdentity: pairedDevice.identity,
          instanceId: "stable-instance-for-legacy-device-id",
          commands: ["system.which"],
        });

        await vi.waitFor(async () => {
          const list = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
          }>(controlWs, "node.list", {});
          const node = list.payload?.nodes?.find(
            (entry) => entry.nodeId === pairedDevice.identity.deviceId,
          );
          if (node?.connected && node.commands?.includes("system.which")) {
            return;
          }
          throw new Error(`legacy node commands not visible yet: ${JSON.stringify(list.payload)}`);
        });
      } finally {
        controlWs.close();
        await nodeClient?.stopAndWait();
      }
    });

    test("does not let an unmatched device overwrite an approved stable node session", async () => {
      const approvedDevice = await pairDeviceIdentity({
        name: "node-stable-approved",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const otherDevice = await pairDeviceIdentity({
        name: "node-stable-other",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const stableNodeId = "stable-node-spoof-guard";
      const request = await requestNodePairing({
        nodeId: stableNodeId,
        deviceId: approvedDevice.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["system.which"],
      });
      requireApprovedPairing(
        await approveNodePairing(request.request.requestId, {
          callerScopes: ["operator.pairing", "operator.admin"],
        }),
      );

      const controlWs = await openTrackedWs(started.port);
      let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, { token: "secret" });
        nodeClient = await connectNodeClient({
          port: started.port,
          deviceIdentity: otherDevice.identity,
          instanceId: stableNodeId,
          commands: ["system.which"],
        });

        await vi.waitFor(async () => {
          const list = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
          }>(controlWs, "node.list", {});
          const stableNode = list.payload?.nodes?.find((entry) => entry.nodeId === stableNodeId);
          const quarantinedNode = list.payload?.nodes?.find(
            (entry) => entry.nodeId === otherDevice.identity.deviceId,
          );
          if (
            stableNode?.connected !== true &&
            quarantinedNode?.connected === true &&
            (quarantinedNode.commands ?? []).length === 0
          ) {
            return;
          }
          throw new Error(
            `spoofed stable node not quarantined yet: ${JSON.stringify(list.payload)}`,
          );
        });
        const pairedStableNode = await getPairedNode(stableNodeId);
        expect(pairedStableNode?.lastConnectedAtMs).toBeUndefined();
      } finally {
        controlWs.close();
        await nodeClient?.stopAndWait();
      }
    });

    test("does not refresh rejected stable node metadata through a legacy pairing match", async () => {
      const approvedDevice = await pairDeviceIdentity({
        name: "node-stable-metadata-approved",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const legacyDevice = await pairDeviceIdentity({
        name: "node-stable-metadata-legacy",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const stableNodeId = "stable-node-metadata-spoof-guard";
      const stableRequest = await requestNodePairing({
        nodeId: stableNodeId,
        deviceId: approvedDevice.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["system.which"],
      });
      requireApprovedPairing(
        await approveNodePairing(stableRequest.request.requestId, {
          callerScopes: ["operator.pairing", "operator.admin"],
        }),
      );
      const legacyRequest = await requestNodePairing({
        nodeId: legacyDevice.identity.deviceId,
        deviceId: legacyDevice.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["system.which"],
      });
      requireApprovedPairing(
        await approveNodePairing(legacyRequest.request.requestId, {
          callerScopes: ["operator.pairing", "operator.admin"],
        }),
      );

      const controlWs = await openTrackedWs(started.port);
      let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, { token: "secret" });
        nodeClient = await connectNodeClient({
          port: started.port,
          deviceIdentity: legacyDevice.identity,
          instanceId: stableNodeId,
          commands: ["system.which"],
        });

        await vi.waitFor(async () => {
          const list = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
          }>(controlWs, "node.list", {});
          const stableNode = list.payload?.nodes?.find((entry) => entry.nodeId === stableNodeId);
          const legacyNode = list.payload?.nodes?.find(
            (entry) => entry.nodeId === legacyDevice.identity.deviceId,
          );
          if (
            stableNode?.connected !== true &&
            legacyNode?.connected === true &&
            legacyNode.commands?.includes("system.which")
          ) {
            return;
          }
          throw new Error(`legacy-matched spoof not isolated yet: ${JSON.stringify(list.payload)}`);
        });

        await vi.waitFor(async () => {
          const pairedLegacyNode = await getPairedNode(legacyDevice.identity.deviceId);
          expect(pairedLegacyNode?.lastConnectedAtMs).toBeDefined();
        });
        const pairedStableNode = await getPairedNode(stableNodeId);
        expect(pairedStableNode?.lastConnectedAtMs).toBeUndefined();
      } finally {
        controlWs.close();
        await nodeClient?.stopAndWait();
      }
    });

    test("deauthorizes a stale stable session when approval moves to another device", async () => {
      const approvedDevice = await pairDeviceIdentity({
        name: "node-stable-rebind-approved",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const otherDevice = await pairDeviceIdentity({
        name: "node-stable-rebind-other",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const stableNodeId = "stable-node-rebind-guard";
      const request = await requestNodePairing({
        nodeId: stableNodeId,
        deviceId: approvedDevice.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["system.which"],
      });
      requireApprovedPairing(
        await approveNodePairing(request.request.requestId, {
          callerScopes: ["operator.pairing", "operator.admin"],
        }),
      );

      const controlWs = await openTrackedWs(started.port);
      let approvedClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      let otherClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await connectOk(controlWs, {
          token: "secret",
          scopes: ["operator.pairing", "operator.admin"],
        });
        approvedClient = await connectNodeClient({
          port: started.port,
          deviceIdentity: approvedDevice.identity,
          instanceId: stableNodeId,
          commands: ["system.which"],
        });
        await vi.waitFor(async () => {
          const list = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
          }>(controlWs, "node.list", {});
          const node = list.payload?.nodes?.find((entry) => entry.nodeId === stableNodeId);
          if (node?.connected && node.commands?.includes("system.which")) {
            return;
          }
          throw new Error(
            `approved stable node not connected yet: ${JSON.stringify(list.payload)}`,
          );
        });

        otherClient = await connectNodeClient({
          port: started.port,
          deviceIdentity: otherDevice.identity,
          instanceId: stableNodeId,
          commands: ["system.which"],
        });
        const pairing = await listNodePairing();
        const pending = pairing.pending.find(
          (entry) =>
            entry.nodeId === stableNodeId && entry.deviceId === otherDevice.identity.deviceId,
        );
        expect(pending?.requestId).toBeTruthy();
        const approve = await rpcReq(controlWs, "node.pair.approve", {
          requestId: pending?.requestId,
        });
        expect(approve.ok).toBe(true);

        await vi.waitFor(async () => {
          const list = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
          }>(controlWs, "node.list", {});
          const node = list.payload?.nodes?.find((entry) => entry.nodeId === stableNodeId);
          const quarantinedNode = list.payload?.nodes?.find(
            (entry) => entry.nodeId === otherDevice.identity.deviceId,
          );
          if (
            node?.connected === true &&
            node.commands?.includes("system.which") &&
            quarantinedNode?.connected !== true
          ) {
            return;
          }
          throw new Error(`rebound stable node not promoted yet: ${JSON.stringify(list.payload)}`);
        });
      } finally {
        controlWs.close();
        await approvedClient?.stopAndWait();
        await otherClient?.stopAndWait();
      }
    });

    test("does not let a no-device node overwrite an approved stable node session", async () => {
      const approvedDevice = await pairDeviceIdentity({
        name: "node-stable-nodevice-approved",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      const stableNodeId = "stable-node-nodevice-spoof-guard";
      const request = await requestNodePairing({
        nodeId: stableNodeId,
        deviceId: approvedDevice.identity.deviceId,
        platform: "macos",
        deviceFamily: "Mac",
        commands: ["system.which"],
      });
      requireApprovedPairing(
        await approveNodePairing(request.request.requestId, {
          callerScopes: ["operator.pairing", "operator.admin"],
        }),
      );

      const controlWs = await openTrackedWs(started.port);
      const nodeWs = await openTrackedWs(started.port);
      try {
        await connectOk(controlWs, { token: "secret" });
        const connect = await connectReq(nodeWs, {
          token: "secret",
          role: "node",
          scopes: [],
          device: null,
          client: {
            id: GATEWAY_CLIENT_NAMES.NODE_HOST,
            displayName: "no-device-node",
            version: "1.0.0",
            platform: "macos",
            deviceFamily: "Mac",
            mode: GATEWAY_CLIENT_MODES.NODE,
            instanceId: stableNodeId,
          },
          commands: ["system.which"],
        });
        expect(connect.ok).toBe(false);
        expect(connect.error?.message).toContain("device identity required");

        const list = await rpcReq<{
          nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
        }>(controlWs, "node.list", {});
        const stableNode = list.payload?.nodes?.find((entry) => entry.nodeId === stableNodeId);
        expect(stableNode?.connected).not.toBe(true);
      } finally {
        controlWs.close();
        nodeWs.close();
      }
    });
  });
});
