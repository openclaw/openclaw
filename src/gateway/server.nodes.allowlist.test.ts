import { describe, expect, test } from "vitest";

import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";
import { GatewayClient } from "./client.js";

installGatewayTestHooks();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const connectNodeClient = async (params: {
  port: number;
  commands: string[];
  instanceId?: string;
  displayName?: string;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
}) => {
  let settled = false;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((err: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientVersion: "1.0.0",
    clientDisplayName: params.displayName,
    platform: "ios",
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: params.instanceId,
    scopes: [],
    commands: params.commands,
    onEvent: params.onEvent,
    onHelloOk: () => {
      if (settled) return;
      settled = true;
      resolveReady?.();
    },
    onConnectError: (err) => {
      if (settled) return;
      settled = true;
      rejectReady?.(err);
    },
    onClose: (code, reason) => {
      if (settled) return;
      settled = true;
      rejectReady?.(new Error(`gateway closed (${code}): ${reason}`));
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

describe("gateway node command allowlist", () => {
  test("rejects commands outside platform allowlist", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);

    const nodeClient = await connectNodeClient({
      port,
      commands: ["system.run"],
    });

    const listRes = await rpcReq<{ nodes?: Array<{ nodeId: string }> }>(ws, "node.list", {});
    const nodeId = listRes.payload?.nodes?.[0]?.nodeId ?? "";
    expect(nodeId).toBeTruthy();

    const res = await rpcReq(ws, "node.invoke", {
      nodeId,
      command: "system.run",
      params: { command: "echo hi" },
      idempotencyKey: "allowlist-1",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("node command not allowed");

    nodeClient.stop();
    ws.close();
    await server.close();
  });

  test("rejects commands not declared by node", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);

    const nodeClient = await connectNodeClient({
      port,
      commands: [],
      instanceId: "node-empty",
      displayName: "node-empty",
    });

    const listRes = await rpcReq<{ nodes?: Array<{ nodeId: string }> }>(ws, "node.list", {});
    const nodeId = listRes.payload?.nodes?.find((entry) => entry.nodeId)?.nodeId ?? "";
    expect(nodeId).toBeTruthy();

    const res = await rpcReq(ws, "node.invoke", {
      nodeId,
      command: "canvas.snapshot",
      params: {},
      idempotencyKey: "allowlist-2",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("node command not allowed");

    nodeClient.stop();
    ws.close();
    await server.close();
  });

  test("allows declared command within allowlist", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);

    let resolveInvoke: ((payload: { id?: string; nodeId?: string }) => void) | null = null;
    const invokeReqP = new Promise<{ id?: string; nodeId?: string }>((resolve) => {
      resolveInvoke = resolve;
    });
    const nodeClient = await connectNodeClient({
      port,
      commands: ["canvas.snapshot"],
      instanceId: "node-allowed",
      displayName: "node-allowed",
      onEvent: (evt) => {
        if (evt.event === "node.invoke.request") {
          const payload = evt.payload as { id?: string; nodeId?: string };
          resolveInvoke?.(payload);
        }
      },
    });

    const listRes = await rpcReq<{ nodes?: Array<{ nodeId: string }> }>(ws, "node.list", {});
    const nodeId = listRes.payload?.nodes?.[0]?.nodeId ?? "";
    expect(nodeId).toBeTruthy();

    const invokeResP = rpcReq(ws, "node.invoke", {
      nodeId,
      command: "canvas.snapshot",
      params: { format: "png" },
      idempotencyKey: "allowlist-3",
    });

    const payload = await invokeReqP;
    const requestId = payload?.id ?? "";
    const nodeIdFromReq = payload?.nodeId ?? "node-allowed";

    await nodeClient.request("node.invoke.result", {
      id: requestId,
      nodeId: nodeIdFromReq,
      ok: true,
      payloadJSON: JSON.stringify({ ok: true }),
    });

    const invokeRes = await invokeResP;
    expect(invokeRes.ok).toBe(true);

    nodeClient.stop();
    ws.close();
    await server.close();
  });

  test("accepts node invoke result with null payloadJSON", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);

    let resolveInvoke: ((payload: { id?: string; nodeId?: string }) => void) | null = null;
    const invokeReqP = new Promise<{ id?: string; nodeId?: string }>((resolve) => {
      resolveInvoke = resolve;
    });
    const nodeClient = await connectNodeClient({
      port,
      commands: ["canvas.snapshot"],
      instanceId: "node-null-payloadjson",
      displayName: "node-null-payloadjson",
      onEvent: (evt) => {
        if (evt.event === "node.invoke.request") {
          const payload = evt.payload as { id?: string; nodeId?: string };
          resolveInvoke?.(payload);
        }
      },
    });

    const listRes = await rpcReq<{ nodes?: Array<{ nodeId: string }> }>(ws, "node.list", {});
    const nodeId = listRes.payload?.nodes?.[0]?.nodeId ?? "";
    expect(nodeId).toBeTruthy();

    const invokeResP = rpcReq(ws, "node.invoke", {
      nodeId,
      command: "canvas.snapshot",
      params: { format: "png" },
      idempotencyKey: "allowlist-null-payloadjson",
    });

    const payload = await invokeReqP;
    const requestId = payload?.id ?? "";
    const nodeIdFromReq = payload?.nodeId ?? "node-null-payloadjson";

    await nodeClient.request("node.invoke.result", {
      id: requestId,
      nodeId: nodeIdFromReq,
      ok: true,
      payloadJSON: null,
    });

    const invokeRes = await invokeResP;
    expect(invokeRes.ok).toBe(true);

    nodeClient.stop();
    ws.close();
    await server.close();
  });
});
