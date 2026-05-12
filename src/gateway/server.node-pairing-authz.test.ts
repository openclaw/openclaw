import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  approveNodePairing,
  getPairedNode,
  listNodePairing,
  requestNodePairing,
} from "../infra/node-pairing.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
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
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function connectNodeClient(params: {
  port: number;
  deviceIdentity: ReturnType<typeof loadDeviceIdentity>["identity"];
  commands: string[];
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
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
    onEvent: params.onEvent,
    timeoutMessage: "timeout waiting for paired node to connect",
  });
}

async function expectPairingApprovalRejected(params: {
  started: Awaited<ReturnType<typeof startServerWithClient>>;
  nodeId: string;
  approverName: string;
  tokenScopes: string[];
  connectedScopes: string[];
  requestCommands?: string[];
  expectedMessage: string;
}) {
  const { started } = params;
  const approver = await issueOperatorToken({
    name: params.approverName,
    approvedScopes: ["operator.admin"],
    tokenScopes: params.tokenScopes,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });

  let pairingWs: WebSocket | undefined;
  try {
    const request = await requestNodePairing({
      nodeId: params.nodeId,
      platform: "darwin",
      ...(params.requestCommands ? { commands: params.requestCommands } : {}),
    });

    pairingWs = await openTrackedWs(started.port);
    await connectOk(pairingWs, {
      skipDefaultAuth: true,
      deviceToken: approver.token,
      deviceIdentityPath: approver.identityPath,
      scopes: params.connectedScopes,
    });

    const approve = await rpcReq(pairingWs, "node.pair.approve", {
      requestId: request.request.requestId,
    });
    expect(approve.ok).toBe(false);
    expect(approve.error?.message).toBe(params.expectedMessage);

    await expect(getPairedNode(params.nodeId)).resolves.toBeNull();
  } finally {
    pairingWs?.close();
  }
}

async function expectRePairingRequest(params: {
  pairedName: string;
  initialCommands?: string[];
  reconnectCommands: string[];
  approvalScopes: string[];
  expectedVisibleCommands: string[];
}) {
  const started = await startServerWithClient("secret");
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
    controlWs = await openTrackedWs(started.port);
    await connectOk(controlWs, { token: "secret" });

    if (params.initialCommands) {
      firstClient = await connectNodeClient({
        port: started.port,
        deviceIdentity: pairedNode.identity,
        commands: params.initialCommands,
      });
      await firstClient.stopAndWait();
    }

    const request = await requestNodePairing({
      nodeId: pairedNode.identity.deviceId,
      platform: "darwin",
      ...(params.initialCommands ? { commands: params.initialCommands } : {}),
    });
    await approveNodePairing(request.request.requestId, {
      callerScopes: params.approvalScopes,
    });

    nodeClient = await connectNodeClient({
      port: started.port,
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
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
}

describe("gateway node pairing authorization", () => {
  test("enforces node pairing approval scopes", async () => {
    const started = await startServerWithClient("secret");
    let pairingWs: WebSocket | undefined;
    try {
      await expectPairingApprovalRejected({
        started,
        nodeId: "node-approve-reject-admin",
        approverName: "node-pair-approve-pairing-only",
        tokenScopes: ["operator.pairing"],
        connectedScopes: ["operator.pairing"],
        requestCommands: ["system.run"],
        expectedMessage: "missing scope: operator.admin",
      });

      await expectPairingApprovalRejected({
        started,
        nodeId: "node-approve-reject-pairing",
        approverName: "node-pair-approve-attacker",
        tokenScopes: ["operator.write"],
        connectedScopes: ["operator.write"],
        requestCommands: ["system.run"],
        expectedMessage: "missing scope: operator.pairing",
      });

      const approver = await issueOperatorToken({
        name: "node-pair-approve-commandless",
        approvedScopes: ["operator.admin"],
        tokenScopes: ["operator.pairing"],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
      });

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

      const pairedNode = await getPairedNode("node-approve-target");
      expect(pairedNode?.nodeId).toBe("node-approve-target");
    } finally {
      pairingWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("blocks system command forwarding when node approval is rejected", async () => {
    const started = await startServerWithClient("secret");
    const pairedNode = await pairDeviceIdentity({
      name: "node-invoke-needs-approval",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
    });
    const operator = await issueOperatorToken({
      name: "node-invoke-pairing-write",
      approvedScopes: ["operator.admin"],
      tokenScopes: ["operator.pairing", "operator.write"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let sawInvoke = false;
    let operatorWs: WebSocket | undefined;
    let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      nodeClient = await connectNodeClient({
        port: started.port,
        deviceIdentity: pairedNode.identity,
        commands: ["system.run"],
        onEvent: (evt) => {
          if (evt.event === "node.invoke.request") {
            sawInvoke = true;
          }
        },
      });

      operatorWs = await openTrackedWs(started.port);
      await connectOk(operatorWs, {
        skipDefaultAuth: true,
        deviceToken: operator.token,
        deviceIdentityPath: operator.identityPath,
        scopes: ["operator.pairing", "operator.write"],
      });

      const list = await rpcReq<{
        pending?: Array<{ requestId?: string; nodeId?: string; commands?: string[] }>;
      }>(operatorWs, "node.pair.list", {});
      expect(list.ok).toBe(true);
      const pending = list.payload?.pending?.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId,
      );
      if (!pending?.requestId) {
        throw new Error("expected pending node pairing request");
      }
      expect(pending?.commands).toEqual(["system.run"]);

      const approve = await rpcReq(operatorWs, "node.pair.approve", {
        requestId: pending.requestId,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.admin");

      const invoke = await rpcReq(operatorWs, "node.invoke", {
        nodeId: pairedNode.identity.deviceId,
        command: "system.run",
        params: { command: ["echo", "blocked"], rawCommand: "echo blocked" },
        timeoutMs: 25,
        idempotencyKey: "node-invoke-needs-node-approval",
      });
      expect(invoke.ok).toBe(false);
      expect(invoke.error?.message).toBe("node pairing approval required");
      expect(sawInvoke).toBe(false);
    } finally {
      operatorWs?.close();
      await nodeClient?.stopAndWait();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("refreshes remote bins after approving a connected macOS node", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-pair-skills-"));
    const bin = `bin-${randomUUID()}`;
    fs.mkdirSync(path.join(workspaceDir, "remote-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "remote-skill", "SKILL.md"),
      [
        "---",
        "name: remote-skill",
        "description: Needs a remote bin",
        `metadata: { "openclaw": { "os": ["darwin"], "requires": { "bins": ["${bin}"] } } }`,
        "---",
        "# Remote Skill",
        "",
      ].join("\n"),
    );
    testState.agentConfig = { workspace: workspaceDir };
    const previousMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
    let probeCount = 0;
    let nodeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      started = await startServerWithClient("secret");
      const activeStarted = started;
      const pairedNode = await pairDeviceIdentity({
        name: "node-approval-refreshes-bins",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });

      await connectOk(activeStarted.ws, { token: "secret" });
      nodeClient = await connectNodeClient({
        port: activeStarted.port,
        deviceIdentity: pairedNode.identity,
        commands: ["system.run", "system.which"],
        onEvent: (evt) => {
          if (evt.event !== "node.invoke.request") {
            return;
          }
          const payload = evt.payload as {
            id?: unknown;
            nodeId?: unknown;
            command?: unknown;
          };
          if (payload.command !== "system.which") {
            return;
          }
          const id = typeof payload.id === "string" ? payload.id : "";
          const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "";
          if (!id || !nodeId) {
            return;
          }
          probeCount += 1;
          void nodeClient?.request("node.invoke.result", {
            id,
            nodeId,
            ok: true,
            payloadJSON: JSON.stringify({ bins: { [bin]: `/usr/bin/${bin}` } }),
          });
        },
      });

      let requestId = "";
      await vi.waitFor(
        async () => {
          const list = await rpcReq<{
            pending?: Array<{ requestId?: string; nodeId?: string; commands?: string[] }>;
          }>(activeStarted.ws, "node.pair.list", {});
          const pending = list.payload?.pending?.find(
            (entry) => entry.nodeId === pairedNode.identity.deviceId,
          );
          if (!pending?.requestId) {
            throw new Error("expected pending node pairing request");
          }
          requestId = pending.requestId;
        },
        {
          timeout: 5_000,
          interval: 50,
        },
      );
      expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);

      const approve = await rpcReq(activeStarted.ws, "node.pair.approve", { requestId });
      expect(approve.ok).toBe(true);

      await vi.waitFor(
        () => {
          if (probeCount < 1 || !(getRemoteSkillEligibility()?.hasBin(bin) ?? false)) {
            throw new Error("expected remote bin refresh after node approval");
          }
        },
        {
          timeout: 5_000,
          interval: 50,
        },
      );
    } finally {
      await nodeClient?.stopAndWait();
      started?.ws.close();
      await started?.server.close();
      started?.envSnapshot.restore();
      if (previousMinimalGateway === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimalGateway;
      }
      testState.agentConfig = undefined;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("requests re-pairing when a paired node reconnects with upgraded commands", async () => {
    await expectRePairingRequest({
      pairedName: "node-command-pin",
      initialCommands: ["screen.snapshot"],
      reconnectCommands: ["screen.snapshot", "system.run"],
      approvalScopes: ["operator.pairing", "operator.write"],
      expectedVisibleCommands: ["screen.snapshot"],
    });
  });

  test("requests re-pairing when a commandless paired node reconnects with system.run", async () => {
    await expectRePairingRequest({
      pairedName: "node-command-empty",
      reconnectCommands: ["screen.snapshot", "system.run"],
      approvalScopes: ["operator.pairing"],
      expectedVisibleCommands: [],
    });
  });
});
