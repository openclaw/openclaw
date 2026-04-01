import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  approveNodePairing,
  getPairedNode,
  listNodePairing,
  requestNodePairing,
} from "../infra/node-pairing.js";
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
  test("requires operator.write before node pairing approvals", async () => {
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
      expect(approve.error?.message).toBe("missing scope: operator.write");

      await expect(getPairedNode("node-approve-target")).resolves.toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("rejects approving exec-capable node commands above the caller session scopes", async () => {
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
      expect(approve.error?.message).toBe("missing scope: operator.admin");

      await expect(getPairedNode("node-approve-target")).resolves.toBeNull();
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("pins connected node commands to the approved pairing record", async () => {
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
      await approveNodePairing(request.request.requestId);

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
          JSON.stringify(node?.commands?.toSorted() ?? []) === JSON.stringify(["canvas.snapshot"])
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const connectedNode = lastNodes.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
      );
      expect(connectedNode?.commands?.toSorted(), JSON.stringify(lastNodes)).toEqual([
        "canvas.snapshot",
      ]);

      const invoke = await rpcReq(controlWs, "node.invoke", {
        nodeId: pairedNode.identity.deviceId,
        command: "system.run",
        params: { command: "echo blocked" },
        idempotencyKey: "node-command-pin",
      });
      expect(invoke.ok).toBe(false);
      expect(invoke.error?.message ?? "").toContain("node command not allowed");
    } finally {
      controlWs?.close();
      await firstClient?.stopAndWait();
      await nodeClient?.stopAndWait();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("requests repair pairing and restores approved commands after reconnect", async () => {
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
      await approveNodePairing(initialApproval.request.requestId);

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
        if ((node?.commands?.length ?? 0) === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const connectedNode = lastNodes.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId && entry.connected,
      );
      expect(connectedNode?.commands ?? [], JSON.stringify(lastNodes)).toEqual([]);

      const repairDeadline = Date.now() + 2_000;
      let repairRequestId = "";
      while (Date.now() < repairDeadline) {
        const pairing = await listNodePairing();
        const repair = pairing.pending.find(
          (entry) => entry.nodeId === pairedNode.identity.deviceId,
        );
        if (repair) {
          repairRequestId = repair.requestId;
          expect(repair.isRepair).toBe(true);
          expect(repair.repairReason).toBe("approved-command-drift");
          expect(repair.commands).toEqual(["canvas.snapshot", "system.run"]);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(repairRequestId).toBeTruthy();

      await approveNodePairing(repairRequestId);
      await nodeClient.stopAndWait();
      nodeClient = await connectNodeClient({
        port: started.port,
        deviceIdentity: pairedNode.identity,
        commands: ["canvas.snapshot", "system.run"],
      });

      const restoredDeadline = Date.now() + 2_000;
      while (Date.now() < restoredDeadline) {
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

      await expect(getPairedNode(pairedNode.identity.deviceId)).resolves.toEqual(
        expect.objectContaining({
          commands: ["canvas.snapshot", "system.run"],
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
