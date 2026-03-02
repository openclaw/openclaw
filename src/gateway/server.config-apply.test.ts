import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { __testing as controlPlaneRateLimitTesting } from "./control-plane-rate-limit.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  startGatewayServer,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;

beforeAll(async () => {
  port = await getFreePort();
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

beforeEach(() => {
  controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
});

afterAll(async () => {
  await server.close();
});

const openClient = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, {
    deviceIdentityPath: path.join(os.tmpdir(), "openclaw-test-device-config-apply.json"),
  });
  return ws;
};

const sendConfigApply = async (ws: WebSocket, id: string, raw: unknown) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "config.apply",
      params: { raw },
    }),
  );
  return onceMessage<{ ok: boolean; error?: { message?: string } }>(ws, (o) => {
    const msg = o as { type?: string; id?: string };
    return msg.type === "res" && msg.id === id;
  });
};

const sendRpc = async (
  ws: WebSocket,
  id: string,
  method: string,
  params: Record<string, unknown>,
) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }),
  );
  return onceMessage<{
    ok: boolean;
    payload?: Record<string, unknown>;
    error?: { message?: string };
  }>(ws, (o) => {
    const msg = o as { type?: string; id?: string };
    return msg.type === "res" && msg.id === id;
  });
};

describe("gateway config.apply", () => {
  it("rejects invalid raw config", async () => {
    const ws = await openClient();
    try {
      const id = "req-1";
      const res = await sendConfigApply(ws, id, "{");
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toMatch(/invalid|SyntaxError/i);
    } finally {
      ws.close();
    }
  });

  it("requires raw to be a string", async () => {
    const ws = await openClient();
    try {
      const id = "req-2";
      const res = await sendConfigApply(ws, id, { gateway: { mode: "local" } });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("raw");
    } finally {
      ws.close();
    }
  });

  it("omits full config from config.apply response by default", async () => {
    const ws = await openClient();
    try {
      const snapshot = await sendRpc(ws, "req-3-get", "config.get", {});
      expect(snapshot.ok).toBe(true);
      const snapshotConfig = snapshot.payload?.config;
      expect(snapshotConfig).toBeTruthy();
      const baseHash = snapshot.payload?.hash;
      const res = await sendRpc(ws, "req-3-apply", "config.apply", {
        raw: JSON.stringify(snapshotConfig),
        restartDelayMs: 60_000,
        ...(typeof baseHash === "string" ? { baseHash } : {}),
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.config).toBeUndefined();
      expect(Array.isArray(res.payload?.changedPaths)).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("returns full config when config.apply sets returnFull=true", async () => {
    const ws = await openClient();
    try {
      const snapshot = await sendRpc(ws, "req-4-get", "config.get", {});
      expect(snapshot.ok).toBe(true);
      const snapshotConfig = snapshot.payload?.config;
      expect(snapshotConfig).toBeTruthy();
      const baseHash = snapshot.payload?.hash;
      const res = await sendRpc(ws, "req-4-apply", "config.apply", {
        raw: JSON.stringify(snapshotConfig),
        returnFull: true,
        restartDelayMs: 60_000,
        ...(typeof baseHash === "string" ? { baseHash } : {}),
      });
      if (!res.ok) {
        throw new Error(`config.apply failed: ${res.error?.message ?? "unknown error"}`);
      }
      expect(res.payload?.config).toBeTruthy();
    } finally {
      ws.close();
    }
  });
});
