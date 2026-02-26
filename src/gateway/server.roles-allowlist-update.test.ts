import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { CONFIG_PATH } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";

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
import { installGatewayTestHooks, onceMessage, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 1_000, interval: 2 } as const;

let ws: WebSocket;
let port: number;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

const connectNodeClient = async (params: {
  port: number;
  commands: string[];
  platform?: string;
  deviceFamily?: string;
  deviceIdentity?: DeviceIdentity;
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
    platform: params.platform ?? "ios",
    deviceFamily: params.deviceFamily,
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: params.instanceId,
    scopes: [],
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    onEvent: params.onEvent,
    timeoutMessage: "timeout waiting for node to connect",
  });
};

const approveAllPendingPairings = async () => {
  const { approveDevicePairing, listDevicePairing } = await import("../infra/device-pairing.js");
  const list = await listDevicePairing();
  for (const pending of list.pending) {
    await approveDevicePairing(pending.requestId);
  }
};

const connectNodeClientWithPairing = async (params: Parameters<typeof connectNodeClient>[0]) => {
  try {
    return await connectNodeClient(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("pairing required")) {
      throw error;
    }
    await approveAllPendingPairings();
    return await connectNodeClient(params);
  }
};

describe("gateway role enforcement", () => {
  test("enforces operator and node permissions", async () => {
    let nodeClient: GatewayClient | undefined;

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

      nodeClient = await connectNodeClientWithPairing({
        port,
        commands: [],
        instanceId: "node-role-enforcement",
        displayName: "node-role-enforcement",
      });

      const binsPayload = await nodeClient.request<{ bins?: unknown[] }>("skills.bins", {});
      expect(Array.isArray(binsPayload?.bins)).toBe(true);

      await expect(nodeClient.request("status", {})).rejects.toThrow("unauthorized role");

      const healthPayload = await nodeClient.request("health", {});
      expect(healthPayload).toBeDefined();
    } finally {
      nodeClient?.stop();
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
      const res = await onceMessage(ws, (o) => o.type === "res" && o.id === id);
      expect(res.ok).toBe(true);

      await vi.waitFor(() => {
        expect(sigusr1.mock.calls.length).toBeGreaterThan(0);
      }, FAST_WAIT_OPTS);
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
      const res = await onceMessage(ws, (o) => o.type === "res" && o.id === id);
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
        .poll(async () => {
          const listRes = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean }>;
          }>(ws, "node.list", {});
          const nodes = listRes.payload?.nodes ?? [];
          return nodes.filter((node) => node.connected).length;
        }, FAST_WAIT_OPTS)
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
      systemClient = await connectNodeClientWithPairing({
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

      emptyClient = await connectNodeClientWithPairing({
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
      allowedClient = await connectNodeClientWithPairing({
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

  test("rejects reconnect metadata spoof for paired node devices", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const deviceIdentityPath = path.join(
      os.tmpdir(),
      `openclaw-spoof-test-device-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const deviceIdentity = loadOrCreateDeviceIdentity(deviceIdentityPath);

    let iosClient: GatewayClient | undefined;
    try {
      iosClient = await connectNodeClientWithPairing({
        port,
        commands: ["canvas.snapshot"],
        platform: "ios",
        deviceFamily: "iPhone",
        instanceId: "node-platform-pin",
        displayName: "node-platform-pin",
        deviceIdentity,
      });
      iosClient.stop();
      await expect
        .poll(async () => {
          const listRes = await rpcReq<{ nodes?: Array<{ connected?: boolean }> }>(
            ws,
            "node.list",
            {},
          );
          return (listRes.payload?.nodes ?? []).filter((node) => node.connected).length;
        }, FAST_WAIT_OPTS)
        .toBe(0);

      await expect(
        connectNodeClient({
          port,
          commands: ["system.run"],
          platform: "linux",
          deviceFamily: "linux",
          instanceId: "node-platform-pin",
          displayName: "node-platform-pin",
          deviceIdentity,
        }),
      ).rejects.toThrow(/pairing required/i);
    } finally {
      iosClient?.stop();
    }
  });
});
