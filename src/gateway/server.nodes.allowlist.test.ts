import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway node command allowlist", () => {
  test("rejects commands outside platform allowlist", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);

    const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => nodeWs.once("open", resolve));
    await connectOk(nodeWs, {
      role: "node",
      client: {
        id: GATEWAY_CLIENT_NAMES.NODE_HOST,
        version: "1.0.0",
        platform: "ios",
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
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

    nodeWs.close();
    ws.close();
    await server.close();
  });

  test("rejects commands not declared by node", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);

    const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => nodeWs.once("open", resolve));
    await connectOk(nodeWs, {
      role: "node",
      client: {
        id: GATEWAY_CLIENT_NAMES.NODE_HOST,
        displayName: "node-empty",
        version: "1.0.0",
        platform: "ios",
        mode: GATEWAY_CLIENT_MODES.NODE,
        instanceId: "node-empty",
      },
      commands: [],
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

    nodeWs.close();
    ws.close();
    await server.close();
  });

  test("allows declared command within allowlist", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);

    const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => nodeWs.once("open", resolve));
    await connectOk(nodeWs, {
      role: "node",
      client: {
        id: GATEWAY_CLIENT_NAMES.NODE_HOST,
        displayName: "node-allowed",
        version: "1.0.0",
        platform: "ios",
        mode: GATEWAY_CLIENT_MODES.NODE,
        instanceId: "node-allowed",
      },
      commands: ["canvas.snapshot"],
    });

    const listRes = await rpcReq<{ nodes?: Array<{ nodeId: string }> }>(ws, "node.list", {});
    const nodeId = listRes.payload?.nodes?.[0]?.nodeId ?? "";
    expect(nodeId).toBeTruthy();

    const invokeReqP = onceMessage<{ type: "event"; event: string; payload?: unknown }>(
      nodeWs,
      (o) => o.type === "event" && o.event === "node.invoke.request",
    );

    const invokeResP = rpcReq(ws, "node.invoke", {
      nodeId,
      command: "canvas.snapshot",
      params: { format: "png" },
      idempotencyKey: "allowlist-3",
    });

    const invokeReq = await invokeReqP;
    const payload = invokeReq.payload as { id?: string; nodeId?: string };
    const requestId = payload?.id ?? "";
    const nodeIdFromReq = payload?.nodeId ?? "node-allowed";

    nodeWs.send(
      JSON.stringify({
        type: "req",
        id: "node-result",
        method: "node.invoke.result",
        params: {
          id: requestId,
          nodeId: nodeIdFromReq,
          ok: true,
          payloadJSON: JSON.stringify({ ok: true }),
        },
      }),
    );

    await onceMessage(nodeWs, (o) => o.type === "res" && o.id === "node-result");

    const invokeRes = await invokeResP;
    expect(invokeRes.ok).toBe(true);

    nodeWs.close();
    ws.close();
    await server.close();
  });
});
