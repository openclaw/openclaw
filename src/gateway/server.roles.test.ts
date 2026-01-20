import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway role enforcement", () => {
  test("operator cannot send node events or invoke results", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const eventRes = await rpcReq(ws, "node.event", { event: "test", payload: { ok: true } });
    expect(eventRes.ok).toBe(false);
    expect(eventRes.error?.message ?? "").toContain("unauthorized role");

    const invokeRes = await rpcReq(ws, "node.invoke.result", {
      id: "invoke-1",
      nodeId: "node-1",
      ok: true,
    });
    expect(invokeRes.ok).toBe(false);
    expect(invokeRes.error?.message ?? "").toContain("unauthorized role");

    ws.close();
    await server.close();
  });

  test("node can fetch skills bins but not control plane methods", async () => {
    const { server, port } = await startServerWithClient();
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
      commands: [],
    });

    const binsRes = await rpcReq<{ bins?: unknown[] }>(nodeWs, "skills.bins", {});
    expect(binsRes.ok).toBe(true);
    expect(Array.isArray(binsRes.payload?.bins)).toBe(true);

    const statusRes = await rpcReq(nodeWs, "status", {});
    expect(statusRes.ok).toBe(false);
    expect(statusRes.error?.message ?? "").toContain("unauthorized role");

    nodeWs.close();
    await server.close();
  });
});
