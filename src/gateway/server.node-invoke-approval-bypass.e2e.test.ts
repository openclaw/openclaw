import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { sleep } from "../utils.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

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

  test("rejects injecting approved/approvalDecision without approval id", async () => {
    let sawInvoke = false;
    const node = await connectLinuxNode(() => {
      sawInvoke = true;
    });
    const ws = await connectOperator(["operator.write"]);

    const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
      ws,
      "node.list",
      {},
    );
    expect(nodes.ok).toBe(true);
    const nodeId = nodes.payload?.nodes?.find((n) => n.connected)?.nodeId ?? "";
    expect(nodeId).toBeTruthy();

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
    await sleep(50);
    expect(sawInvoke).toBe(false);

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

    const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
      ws,
      "node.list",
      {},
    );
    expect(nodes.ok).toBe(true);
    const nodeId = nodes.payload?.nodes?.find((n) => n.connected)?.nodeId ?? "";
    expect(nodeId).toBeTruthy();

    const approvalId = crypto.randomUUID();
    const requestP = rpcReq(ws, "exec.approval.request", {
      id: approvalId,
      command: "echo hi",
      cwd: null,
      host: "node",
      timeoutMs: 30_000,
    });

    await rpcReq(ws, "exec.approval.resolve", { id: approvalId, decision: "allow-once" });
    const requested = await requestP;
    expect(requested.ok).toBe(true);

    const invoke = await rpcReq(ws, "node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command: ["echo", "hi"],
        rawCommand: "echo hi",
        runId: approvalId,
        approved: true,
        // Try to escalate to allow-always; gateway should clamp to allow-once from record.
        approvalDecision: "allow-always",
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(invoke.ok).toBe(true);

    expect(lastInvokeParams).toBeTruthy();
    expect(lastInvokeParams?.approved).toBe(true);
    expect(lastInvokeParams?.approvalDecision).toBe("allow-once");

    ws.close();
    node.stop();
  });
});
