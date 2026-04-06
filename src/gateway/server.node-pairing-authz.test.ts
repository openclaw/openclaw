import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { approveNodePairing, listNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
} from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function connectNodeClient(params: {
  port: number;
  deviceIdentity: ReturnType<typeof loadDeviceIdentity>["identity"];
  commands: string[];
}) {
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token: "secret",
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: "node-command-pin",
    clientVersion: "1.0.0",
    platform: "darwin",
    mode: GATEWAY_CLIENT_MODES.NODE,
    scopes: [],
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    timeoutMessage: "timeout waiting for paired node to connect",
  });
}

describe("gateway node pairing authorization", () => {
  test("requires operator.admin for exec-capable node pairing approvals", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      name: "node-pair-approve-pairing-only",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestNodePairing({
        nodeId: "node-approve-target",
        platform: "darwin",
        commands: ["system.run"],
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        skipDefaultAuth: true,
        deviceToken: approver.token,
        deviceIdentityPath: approver.identityPath,
        scopes: ["operator.pairing"],
      });

      const approve = await rpcReq(pairingWs, "node.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.admin");

      await expect(
        import("../infra/node-pairing.js").then((m) => m.getPairedNode("node-approve-target")),
      ).resolves.toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("requires operator.pairing before node pairing approvals", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      name: "node-pair-approve-attacker",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.write"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestNodePairing({
        nodeId: "node-approve-target",
        platform: "darwin",
        commands: ["system.run"],
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        skipDefaultAuth: true,
        deviceToken: approver.token,
        deviceIdentityPath: approver.identityPath,
        scopes: ["operator.write"],
      });

      const approve = await rpcReq(pairingWs, "node.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.pairing");

      await expect(
        import("../infra/node-pairing.js").then((m) => m.getPairedNode("node-approve-target")),
      ).resolves.toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("allows pairing-only operators to approve commandless node requests", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issueOperatorToken({
      name: "node-pair-approve-commandless",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestNodePairing({
        nodeId: "node-approve-target",
        platform: "darwin",
      });

      pairingWs = await openTrackedWs(started.port);
      await connectOk(pairingWs, {
        skipDefaultAuth: true,
        deviceToken: approver.token,
        deviceIdentityPath: approver.identityPath,
        scopes: ["operator.pairing"],
      });

      const approve = await rpcReq<{
        requestId?: string;
        node?: { nodeId?: string };
      }>(pairingWs, "node.pair.approve", {
        requestId: request.request.requestId,
      });
      expect(approve.ok).toBe(true);
      expect(approve.payload?.requestId).toBe(request.request.requestId);
      expect(approve.payload?.node?.nodeId).toBe("node-approve-target");

      await expect(
        import("../infra/node-pairing.js").then((m) => m.getPairedNode("node-approve-target")),
      ).resolves.toEqual(
        expect.objectContaining({
          nodeId: "node-approve-target",
        }),
      );
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not pin connected node commands to the approved pairing record", async () => {
    const started = await startServerWithClient("secret");
    const pairedNode = await pairDeviceIdentity({
      name: "node-command-pin",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
    });

    let controlWs: WebSocket | undefined;
    let firstClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      controlWs = await openTrackedWs(started.port);
      await connectOk(controlWs, { token: "secret" });

      firstClient = await connectNodeClient({
        port: started.port,
        deviceIdentity: pairedNode.identity,
        commands: ["canvas.snapshot"],
      });
      await firstClient.stopAndWait();

      const request = await requestNodePairing({
        nodeId: pairedNode.identity.deviceId,
        platform: "darwin",
        commands: ["canvas.snapshot"],
      });
      await approveNodePairing(request.request.requestId, {
        callerScopes: ["operator.pairing", "operator.write"],
      });

      nodeClient = await connectNodeClient({
        port: started.port,
        deviceIdentity: pairedNode.identity,
        commands: ["canvas.snapshot", "system.run"],
      });

      const deadline = Date.now() + 2_000;
      let lastNodes: Array<{ nodeId: string; connected?: boolean; commands?: string[] }> = [];
      while (Date.now() < deadline) {
        const list = await rpcReq<{
          nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
        }>(controlWs, "node.list", {});
        lastNodes = list.payload?.nodes ?? [];
        const node = lastNodes.find(
          (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
        );
        if (
          JSON.stringify(node?.commands?.toSorted() ?? []) ===
          JSON.stringify(["canvas.snapshot", "system.run"])
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(
        lastNodes
          .find((entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected)
          ?.commands?.toSorted(),
        JSON.stringify(lastNodes),
      ).toEqual(["canvas.snapshot", "system.run"]);
    } finally {
      controlWs?.close();
      await firstClient?.stopAndWait();
      await nodeClient?.stopAndWait();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not request repair pairing when a paired node reconnects with more commands", async () => {
    const started = await startServerWithClient("secret");
    const pairedNode = await pairDeviceIdentity({
      name: "node-command-empty",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
    });

    let controlWs: WebSocket | undefined;
    let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      controlWs = await openTrackedWs(started.port);
      await connectOk(controlWs, { token: "secret" });

      const initialApproval = await requestNodePairing({
        nodeId: pairedNode.identity.deviceId,
        platform: "darwin",
      });
      await approveNodePairing(initialApproval.request.requestId, {
        callerScopes: ["operator.pairing"],
      });

      nodeClient = await connectNodeClient({
        port: started.port,
        deviceIdentity: pairedNode.identity,
        commands: ["canvas.snapshot", "system.run"],
      });

      const deadline = Date.now() + 2_000;
      let lastNodes: Array<{ nodeId: string; connected?: boolean; commands?: string[] }> = [];
      while (Date.now() < deadline) {
        const list = await rpcReq<{
          nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
        }>(controlWs, "node.list", {});
        lastNodes = list.payload?.nodes ?? [];
        const node = lastNodes.find(
          (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
        );
        if (
          JSON.stringify(node?.commands?.toSorted() ?? []) ===
          JSON.stringify(["canvas.snapshot", "system.run"])
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const repairedNode = lastNodes.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
      );
      expect(repairedNode?.commands?.toSorted(), JSON.stringify(lastNodes)).toEqual([
        "canvas.snapshot",
        "system.run",
      ]);

      await expect(listNodePairing()).resolves.toEqual(
        expect.objectContaining({
          pending: [],
        }),
      );
    } finally {
      controlWs?.close();
      await nodeClient?.stopAndWait();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
