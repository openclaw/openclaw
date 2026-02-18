import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { sleep } from "../utils.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function expectNoForwardedInvoke(hasInvoke: () => boolean): Promise<void> {
  // Yield a couple of macrotasks so any accidental async forwarding would fire.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(hasInvoke()).toBe(false);
}

async function getConnectedNodeId(ws: WebSocket): Promise<string> {
  const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
    ws,
    "node.list",
    {},
  );
  expect(nodes.ok).toBe(true);
  const nodeId = nodes.payload?.nodes?.find((n) => n.connected)?.nodeId ?? "";
  expect(nodeId).toBeTruthy();
  return nodeId;
}

async function requestAllowOnceApproval(ws: WebSocket, command: string): Promise<string> {
  const approvalId = crypto.randomUUID();
  const requestP = rpcReq(ws, "exec.approval.request", {
    id: approvalId,
    command,
    cwd: null,
    host: "node",
    timeoutMs: 30_000,
  });
  await rpcReq(ws, "exec.approval.resolve", { id: approvalId, decision: "allow-once" });
  const requested = await requestP;
  expect(requested.ok).toBe(true);
  return approvalId;
}

describe("node.invoke approval bypass", () => {
  let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
  let port: number;

  beforeAll(async () => {
    const started = await startServerWithClient("secret", { controlUiEnabled: true });
    server = started.server;
    port = started.port;
  });

  afterAll(async () => {
    await server.close();
  });

  const connectOperator = async (scopes: string[]) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    const res = await connectReq(ws, { token: "secret", scopes });
    expect(res.ok).toBe(true);
    return ws;
  };

  const connectOperatorWithNewDevice = async (scopes: string[]) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
    const deviceId = deriveDeviceIdFromPublicKey(publicKeyRaw);
    expect(deviceId).toBeTruthy();
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: deviceId!,
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      role: "operator",
      scopes,
      signedAtMs,
      token: "secret",
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    const res = await connectReq(ws, {
      token: "secret",
      scopes,
      device: {
        id: deviceId!,
        publicKey: publicKeyRaw,
        signature: signDevicePayload(privateKeyPem, payload),
        signedAt: signedAtMs,
      },
    });
    expect(res.ok).toBe(true);
    return ws;
  };

  const connectLinuxNode = async (onInvoke: (payload: unknown) => void) => {
    let readyResolve: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      connectDelayMs: 0,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientVersion: "1.0.0",
      platform: "linux",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: ["system.run"],
      onHelloOk: () => readyResolve?.(),
      onEvent: (evt) => {
        if (evt.event !== "node.invoke.request") {
          return;
        }
        onInvoke(evt.payload);
        const payload = evt.payload as {
          id?: string;
          nodeId?: string;
        };
        const id = typeof payload?.id === "string" ? payload.id : "";
        const nodeId = typeof payload?.nodeId === "string" ? payload.nodeId : "";
        if (!id || !nodeId) {
          return;
        }
        void client.request("node.invoke.result", {
          id,
          nodeId,
          ok: true,
          payloadJSON: JSON.stringify({ ok: true }),
        });
      },
    });
    client.start();
    await Promise.race([
      ready,
      sleep(10_000).then(() => {
        throw new Error("timeout waiting for node to connect");
      }),
    ]);
    return client;
  };

  test("rejects rawCommand/command mismatch before forwarding to node", async () => {
    let sawInvoke = false;
    const node = await connectLinuxNode(() => {
      sawInvoke = true;
    });
    const ws = await connectOperator(["operator.write"]);
    const nodeId = await getConnectedNodeId(ws);

    const res = await rpcReq(ws, "node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command: ["uname", "-a"],
        rawCommand: "echo hi",
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("rawCommand does not match command");

    await expectNoForwardedInvoke(() => sawInvoke);

    ws.close();
    node.stop();
  });

  test("rejects injecting approved/approvalDecision without approval id", async () => {
    let sawInvoke = false;
    const node = await connectLinuxNode(() => {
      sawInvoke = true;
    });
    const ws = await connectOperator(["operator.write"]);
    const nodeId = await getConnectedNodeId(ws);

    const res = await rpcReq(ws, "node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command: ["echo", "hi"],
        rawCommand: "echo hi",
        approved: true,
        approvalDecision: "allow-once",
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("params.runId");

    // Ensure the node didn't receive the invoke (gateway should fail early).
    await expectNoForwardedInvoke(() => sawInvoke);

    ws.close();
    node.stop();
  });

  test("rejects invoking system.execApprovals.set via node.invoke", async () => {
    let sawInvoke = false;
    const node = await connectLinuxNode(() => {
      sawInvoke = true;
    });
    const ws = await connectOperator(["operator.write"]);
    const nodeId = await getConnectedNodeId(ws);

    const res = await rpcReq(ws, "node.invoke", {
      nodeId,
      command: "system.execApprovals.set",
      params: { file: { version: 1, agents: {} }, baseHash: "nope" },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("exec.approvals.node");

    await expectNoForwardedInvoke(() => sawInvoke);

    ws.close();
    node.stop();
  });

  test("binds system.run approval flags to exec.approval decision (ignores caller escalation)", async () => {
    let lastInvokeParams: Record<string, unknown> | null = null;
    const node = await connectLinuxNode((payload) => {
      const obj = payload as { paramsJSON?: unknown };
      const raw = typeof obj?.paramsJSON === "string" ? obj.paramsJSON : "";
      if (!raw) {
        lastInvokeParams = null;
        return;
      }
      lastInvokeParams = JSON.parse(raw) as Record<string, unknown>;
    });

    const ws = await connectOperator(["operator.write", "operator.approvals"]);
    const ws2 = await connectOperator(["operator.write"]);

    const nodeId = await getConnectedNodeId(ws);
    const approvalId = await requestAllowOnceApproval(ws, "echo hi");

    // Use a second WebSocket connection to simulate per-call clients (callGatewayTool/callGatewayCli).
    // Approval binding should be based on device identity, not the ephemeral connId.
    const invoke = await rpcReq(ws2, "node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command: ["echo", "hi"],
        rawCommand: "echo hi",
        runId: approvalId,
        approved: true,
        // Try to escalate to allow-always; gateway should clamp to allow-once from record.
        approvalDecision: "allow-always",
        injected: "nope",
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(invoke.ok).toBe(true);

    const invokeParams = lastInvokeParams as Record<string, unknown> | null;
    expect(invokeParams).toBeTruthy();
    expect(invokeParams?.["approved"]).toBe(true);
    expect(invokeParams?.["approvalDecision"]).toBe("allow-once");
    expect(invokeParams?.["injected"]).toBeUndefined();

    ws.close();
    ws2.close();
    node.stop();
  });

  test("rejects replaying approval id from another device", async () => {
    let sawInvoke = false;
    const node = await connectLinuxNode(() => {
      sawInvoke = true;
    });

    const ws = await connectOperator(["operator.write", "operator.approvals"]);
    const wsOtherDevice = await connectOperatorWithNewDevice(["operator.write"]);

    const nodeId = await getConnectedNodeId(ws);
    const approvalId = await requestAllowOnceApproval(ws, "echo hi");

    const invoke = await rpcReq(wsOtherDevice, "node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command: ["echo", "hi"],
        rawCommand: "echo hi",
        runId: approvalId,
        approved: true,
        approvalDecision: "allow-once",
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(invoke.ok).toBe(false);
    expect(invoke.error?.message ?? "").toContain("not valid for this device");
    await expectNoForwardedInvoke(() => sawInvoke);

    ws.close();
    wsOtherDevice.close();
    node.stop();
  });
});
