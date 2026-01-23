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
  test("enforces command allowlists across node clients", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);

    const waitForConnectedCount = async (count: number) => {
      await expect
        .poll(
          async () => {
            const listRes = await rpcReq<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>(ws, "node.list", {});
            const nodes = listRes.payload?.nodes ?? [];
            return nodes.filter((node) => node.connected).length;
          },
          { timeout: 2_000 },
        )
        .toBe(count);
    };

    const getConnectedNodeId = async () => {
      const listRes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
        ws,
        "node.list",
        {},
      );
      const nodeId = listRes.payload?.nodes?.find((node) => node.connected)?.nodeId ?? "";
      expect(nodeId).toBeTruthy();
      return nodeId;
    };

    try {
      const systemClient = await connectNodeClient({
        port,
        commands: ["system.run"],
        instanceId: "node-system-run",
        displayName: "node-system-run",
      });
      const systemNodeId = await getConnectedNodeId();
      const disallowedRes = await rpcReq(ws, "node.invoke", {
        nodeId: systemNodeId,
        command: "system.run",
        params: { command: "echo hi" },
        idempotencyKey: "allowlist-1",
      });
      expect(disallowedRes.ok).toBe(false);
      expect(disallowedRes.error?.message).toContain("node command not allowed");
      systemClient.stop();
      await waitForConnectedCount(0);

      const emptyClient = await connectNodeClient({
        port,
        commands: [],
        instanceId: "node-empty",
        displayName: "node-empty",
      });
      const emptyNodeId = await getConnectedNodeId();
      const missingRes = await rpcReq(ws, "node.invoke", {
        nodeId: emptyNodeId,
        command: "canvas.snapshot",
        params: {},
        idempotencyKey: "allowlist-2",
      });
      expect(missingRes.ok).toBe(false);
      expect(missingRes.error?.message).toContain("node command not allowed");
      emptyClient.stop();
      await waitForConnectedCount(0);

      let resolveInvoke: ((payload: { id?: string; nodeId?: string }) => void) | null = null;
      const waitForInvoke = () =>
        new Promise<{ id?: string; nodeId?: string }>((resolve) => {
          resolveInvoke = resolve;
        });
      const allowedClient = await connectNodeClient({
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
      const allowedNodeId = await getConnectedNodeId();

      const invokeResP = rpcReq(ws, "node.invoke", {
        nodeId: allowedNodeId,
        command: "canvas.snapshot",
        params: { format: "png" },
        idempotencyKey: "allowlist-3",
      });
      const payload = await waitForInvoke();
      const requestId = payload?.id ?? "";
      const nodeIdFromReq = payload?.nodeId ?? "node-allowed";
      await allowedClient.request("node.invoke.result", {
        id: requestId,
        nodeId: nodeIdFromReq,
        ok: true,
        payloadJSON: JSON.stringify({ ok: true }),
      });
      const invokeRes = await invokeResP;
      expect(invokeRes.ok).toBe(true);

      const invokeNullResP = rpcReq(ws, "node.invoke", {
        nodeId: allowedNodeId,
        command: "canvas.snapshot",
        params: { format: "png" },
        idempotencyKey: "allowlist-null-payloadjson",
      });
      const payloadNull = await waitForInvoke();
      const requestIdNull = payloadNull?.id ?? "";
      const nodeIdNull = payloadNull?.nodeId ?? "node-allowed";
      await allowedClient.request("node.invoke.result", {
        id: requestIdNull,
        nodeId: nodeIdNull,
        ok: true,
        payloadJSON: null,
      });
      const invokeNullRes = await invokeNullResP;
      expect(invokeNullRes.ok).toBe(true);

      allowedClient.stop();
    } finally {
      ws.close();
      await server.close();
    }
  });
});
