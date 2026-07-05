/**
 * Integration test for exec-approvals node preflight guard — real gateway server.
 *
 * Starts a real Gateway WebSocket server and verifies the exec-approvals node
 * handlers return structured errors for unknown nodes (fallthrough to invoke
 * error mapping), connected nodes that lack the required command in their
 * approved command surface, and pre-paired capable nodes whose effective
 * command surface includes exec-approvals.
 *
 * Prints full RPC responses for PR evidence collection.
 */
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DeviceIdentity } from "../../infra/device-identity.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { approveNodePairing, requestNodePairing } from "../../infra/node-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "../test-helpers.js";
import { acknowledgeNodeInvokeRequestForTest } from "../test-helpers.node-invoke.js";

installGatewayTestHooks({ scope: "suite" });

/** Shape of a node entry in node.list RPC response. */
interface NodeListEntry {
  nodeId: string;
  displayName?: string;
  connected?: boolean;
}

describe("exec-approvals node preflight (real gateway)", () => {
  let gateway: Awaited<ReturnType<typeof startServerWithClient>>;
  let limitedNode: Awaited<ReturnType<typeof connectGatewayClient>>;
  let capableNode: Awaited<ReturnType<typeof connectGatewayClient>>;
  let naiveCapableNode: Awaited<ReturnType<typeof connectGatewayClient>>;
  let limitedNodeId: string;
  let capableNodeId: string;
  let naiveCapableNodeId: string;
  let capableIdent: DeviceIdentity;

  beforeAll(async () => {
    gateway = await startServerWithClient("secret");
    await connectOk(gateway.ws);

    // Pre-create distinct device identities so the two node connections don't collide.
    const limitedIdent = loadOrCreateDeviceIdentity(
      path.join(
        process.env.OPENCLAW_STATE_DIR ?? os.tmpdir(),
        "test-device-identities",
        "exec-approvals-limited-node.json",
      ),
    );
    capableIdent = loadOrCreateDeviceIdentity(
      path.join(
        process.env.OPENCLAW_STATE_DIR ?? os.tmpdir(),
        "test-device-identities",
        "exec-approvals-capable-node.json",
      ),
    );

    // Pre-pair the capable node so its approved command surface includes
    // exec-approvals commands.  This simulates a previously paired desktop
    // node that already had exec-approvals in its pairing allowlist.
    // operator.admin is used here as a superset of the required write scope
    // to ensure the pre-pairing succeeds regardless of the current pairing
    // authz defaults.
    const prePairRequest = await requestNodePairing({
      nodeId: capableIdent.deviceId,
      displayName: "capable-node",
      platform: "linux",
      deviceFamily: "Linux",
      commands: [
        "system.run",
        "system.notify",
        "browser.proxy",
        "system.execApprovals.get",
        "system.execApprovals.set",
      ],
    });
    const approved = await approveNodePairing(prePairRequest.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    if (!approved || "status" in approved) {
      throw new Error(`Failed to pre-pair capable node: ${JSON.stringify(approved)}`);
    }

    // Connect a node that does NOT advertise exec-approvals commands.
    limitedNode = await connectGatewayClient({
      url: `ws://127.0.0.1:${gateway.port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "limited-node",
      clientVersion: "1.0.0",
      platform: "linux",
      deviceFamily: "Linux",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: ["system.run", "system.notify", "browser.proxy"],
      deviceIdentity: limitedIdent,
      timeoutMessage: "timeout waiting for limited-node to connect",
    });

    // Connect the pre-paired node that DOES advertise exec-approvals commands.
    // Because it is already paired, reconcileNodePairingOnConnect will find the
    // paired entry and set effectiveCommands to include exec-approvals.
    capableNode = await connectGatewayClient({
      url: `ws://127.0.0.1:${gateway.port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "capable-node",
      clientVersion: "1.0.0",
      platform: "linux",
      deviceFamily: "Linux",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [
        "system.run",
        "system.notify",
        "browser.proxy",
        "system.execApprovals.get",
        "system.execApprovals.set",
      ],
      deviceIdentity: capableIdent,
      timeoutMessage: "timeout waiting for capable-node to connect",
      onEvent: (evt) => {
        if (capableNode) {
          acknowledgeNodeInvokeRequestForTest({
            client: capableNode,
            event: evt,
            onInvoke: () => {},
          });
        }
      },
    });

    // Connect a node that declares exec-approvals commands WITHOUT
    // pre-pairing.  reconcileNodePairingOnConnect returns effectiveCommands:[]
    // (first-connect pending pairing).  The preflight gate should reject
    // exec-approvals RPCs because the effective command surface is empty —
    // raw declared capability is not sufficient to bypass pairing approval.
    naiveCapableNode = await connectGatewayClient({
      url: `ws://127.0.0.1:${gateway.port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "naive-capable-node",
      clientVersion: "1.0.0",
      platform: "linux",
      deviceFamily: "Linux",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [
        "system.run",
        "system.notify",
        "browser.proxy",
        "system.execApprovals.get",
        "system.execApprovals.set",
      ],
      deviceIdentity: loadOrCreateDeviceIdentity(
        path.join(
          process.env.OPENCLAW_STATE_DIR ?? os.tmpdir(),
          "test-device-identities",
          "exec-approvals-naive-capable.json",
        ),
      ),
      timeoutMessage: "timeout waiting for naive-capable-node to connect",
    });

    // Look up connected node IDs from the operator client.
    const listRes = await rpcReq<{ nodes?: NodeListEntry[] }>(gateway.ws, "node.list", {});
    const nodes = listRes.payload?.nodes ?? [];
    const limited = nodes.find((n) => n.displayName === "limited-node");
    const capable = nodes.find((n) => n.displayName === "capable-node");
    const naive = nodes.find((n) => n.displayName === "naive-capable-node");
    if (!limited?.nodeId || !capable?.nodeId || !naive?.nodeId) {
      throw new Error(
        `Failed to find connected nodes in node.list: ` +
          `limited=${limited?.nodeId}, capable=${capable?.nodeId}, naive=${naive?.nodeId}`,
      );
    }
    limitedNodeId = limited.nodeId;
    capableNodeId = capable.nodeId;
    naiveCapableNodeId = naive.nodeId;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([
      disconnectGatewayClient(limitedNode),
      disconnectGatewayClient(capableNode),
      disconnectGatewayClient(naiveCapableNode),
    ]);
    gateway?.ws.close();
    await gateway?.server.close();
  }, 30_000);

  // ---- pre-paired capable-node scenario ----

  test("pre-paired capable node connects and appears in node.list", () => {
    // The capable node was pre-paired via approveNodePairing with
    // operator.admin scope (superset of the required write scope).
    // The node connected successfully and reconcileNodePairingOnConnect
    // found the paired entry, so effectiveCommands include exec-approvals.
    expect(capableNodeId).toBeTruthy();
    // The limited node also connects but without pre-pairing.
    expect(limitedNodeId).toBeTruthy();
    expect(limitedNodeId).not.toBe(capableNodeId);
  });

  test("pre-paired capable node succeeds on exec.approvals.node.get", async () => {
    const res = await rpcReq<{ hash?: string; file?: unknown }>(
      gateway.ws,
      "exec.approvals.node.get",
      { nodeId: capableNodeId },
    );

    console.log(JSON.stringify(res, null, 2));

    expect(res.ok).toBe(true);
    expect(res.payload).toBeDefined();
    // The executing node returns the current approvals file shape for
    // a freshly paired node — a valid response proves the preflight
    // allowlist includes system.execApprovals.get for declared-capable
    // desktop nodes.
  });

  test("pre-paired capable node succeeds on exec.approvals.node.set with empty file", async () => {
    const res = await rpcReq<{ hash?: string }>(gateway.ws, "exec.approvals.node.set", {
      nodeId: capableNodeId,
      file: { version: 1, agents: {} },
    });

    console.log(JSON.stringify(res, null, 2));

    // set succeeds because the capable node declares system.execApprovals.set
    // in its effective command surface and the preflight allowlist includes it.
    expect(res.ok).toBe(true);
  });

  // ---- naive-capable-node scenario (no pre-pairing) ----

  test("naive first-connect node is rejected on exec.approvals.node.get when not yet paired", async () => {
    // The node connected without pre-pairing, so effectiveCommands are empty
    // (pending pairing).  The preflight gate rejects exec-approvals RPCs
    // because the effective command surface is empty — raw declaredCommands
    // alone is not sufficient to bypass pairing approval.
    const res = await rpcReq<{ hash?: string; file?: unknown }>(
      gateway.ws,
      "exec.approvals.node.get",
      { nodeId: naiveCapableNodeId },
    );

    console.log(JSON.stringify(res, null, 2));

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe("INVALID_REQUEST");
    expect(res.error!.message).toContain("does not allow");
  });

  // ---- unknown-node scenarios ----

  test("unknown node falls through to invoke and returns UNAVAILABLE with nodeError", async () => {
    const res = await rpcReq(gateway.ws, "exec.approvals.node.get", {
      nodeId: "node-that-does-not-exist",
    });

    console.log(JSON.stringify(res, null, 2));

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe("UNAVAILABLE");
    expect(res.error!.message).toContain("NOT_CONNECTED");
    expect(res.error!.details).toBeDefined();
    const details = res.error!.details as Record<string, unknown> | undefined;
    expect(details?.nodeError).toBeDefined();
    expect((details?.nodeError as Record<string, unknown>)?.code).toBe("NOT_CONNECTED");
  });

  test("unknown node returns UNAVAILABLE for exec.approvals.node.set", async () => {
    const res = await rpcReq(gateway.ws, "exec.approvals.node.set", {
      nodeId: "ghost-node",
      file: { version: 1, agents: {} },
      baseHash: "abc123",
    });

    console.log(JSON.stringify(res, null, 2));

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe("UNAVAILABLE");
    expect(res.error!.details).toBeDefined();
    const details = res.error!.details as Record<string, unknown> | undefined;
    expect(details?.nodeError).toBeDefined();
  });

  // ---- connected-node unsupported scenarios ----

  test("connected node without exec-approvals.get returns INVALID_REQUEST", async () => {
    const res = await rpcReq(gateway.ws, "exec.approvals.node.get", {
      nodeId: limitedNodeId,
    });

    console.log(JSON.stringify(res, null, 2));

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe("INVALID_REQUEST");
    expect(res.error!.message).toContain("does not support system.execApprovals.get");
    expect(res.error!.details).toBeDefined();
    const details = res.error!.details as Record<string, unknown> | undefined;
    // First-connect nodes have empty effective commands until pairing approved.
    expect(details?.requestedCommand).toBe("system.execApprovals.get");
  });

  test("connected node without exec-approvals.set returns INVALID_REQUEST", async () => {
    const res = await rpcReq(gateway.ws, "exec.approvals.node.set", {
      nodeId: limitedNodeId,
      file: { version: 1, agents: {} },
      baseHash: "abc123",
    });

    console.log(JSON.stringify(res, null, 2));

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe("INVALID_REQUEST");
    expect(res.error!.message).toContain("does not support system.execApprovals.set");
  });

  // ---- local regression ----

  test("gateway responds correctly for exec.approvals.get (local, no node target)", async () => {
    const res = await rpcReq(gateway.ws, "exec.approvals.get", {});

    console.log(JSON.stringify(res, null, 2));

    expect(res.ok).toBe(true);
    expect(res.payload).toBeDefined();
  });
});
