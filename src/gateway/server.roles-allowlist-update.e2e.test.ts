import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { GatewayClient } from "./client.js";
import { CONFIG_PATH } from "../config/config.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(async () => ({
    status: "ok",
    mode: "git",
    root: "/repo",
    steps: [],
    durationMs: 12,
  })),
}));

import { runGatewayUpdate } from "../infra/update-runner.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { connectOk, installGatewayTestHooks, onceMessage, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;
let port: number;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

const connectNodeClient = async (params: {
  port: number;
  commands: string[];
  instanceId?: string;
  displayName?: string;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
}) => {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is required for node test clients");
  }
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token,
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
    timeoutMessage: "timeout waiting for node to connect",
  });
};

async function waitForSignal(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout");
}

describe("gateway role enforcement", () => {
  test("enforces operator and node permissions", async () => {
    const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => nodeWs.once("open", resolve));

    try {
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
    } finally {
      nodeWs.close();
    }
  });
});

describe("gateway update.run", () => {
  test("writes sentinel and schedules restart", async () => {
    const sigusr1 = vi.fn();
    process.on("SIGUSR1", sigusr1);

    try {
      const id = "req-update";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "update.run",
          params: {
            sessionKey: "agent:main:whatsapp:dm:+15555550123",
            restartDelayMs: 0,
          },
        }),
      );
      const res = await onceMessage<{ ok: boolean; payload?: unknown }>(
        ws,
        (o) => o.type === "res" && o.id === id,
      );
      expect(res.ok).toBe(true);

      await waitForSignal(() => sigusr1.mock.calls.length > 0);
      expect(sigusr1).toHaveBeenCalled();

      const sentinelPath = path.join(os.homedir(), ".openclaw", "restart-sentinel.json");
      const raw = await fs.readFile(sentinelPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        payload?: { kind?: string; stats?: { mode?: string } };
      };
      expect(parsed.payload?.kind).toBe("update");
      expect(parsed.payload?.stats?.mode).toBe("git");
    } finally {
      process.off("SIGUSR1", sigusr1);
    }
  });

  test("uses configured update channel", async () => {
    const sigusr1 = vi.fn();
    process.on("SIGUSR1", sigusr1);

    try {
      await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ update: { channel: "beta" } }, null, 2));
      const updateMock = vi.mocked(runGatewayUpdate);
      updateMock.mockClear();

      const id = "req-update-channel";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "update.run",
          params: {
            restartDelayMs: 0,
          },
        }),
      );
      const res = await onceMessage<{ ok: boolean; payload?: unknown }>(
        ws,
        (o) => o.type === "res" && o.id === id,
      );
      expect(res.ok).toBe(true);
      expect(updateMock).toHaveBeenCalledOnce();
    } finally {
      process.off("SIGUSR1", sigusr1);
    }
  });
});

describe("gateway node command allowlist", () => {
  test("enforces command allowlists across node clients", async () => {
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

    let systemClient: GatewayClient | undefined;
    let emptyClient: GatewayClient | undefined;
    let allowedClient: GatewayClient | undefined;

    try {
      systemClient = await connectNodeClient({
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

      emptyClient = await connectNodeClient({
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
      allowedClient = await connectNodeClient({
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
    } finally {
      systemClient?.stop();
      emptyClient?.stop();
      allowedClient?.stop();
    }
  });
});
