import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
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

afterAll(async () => {
  await server.close();
});

const openClient = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws);
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

describe("gateway config.apply", () => {
  it("rejects config.apply when SecretRef resolution fails", async () => {
    const ws = await openClient();
    try {
      const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_APPLY_${Date.now()}`;
      delete process.env[missingEnvVar];
      const getId = "req-secretref-get";
      ws.send(
        JSON.stringify({
          type: "req",
          id: getId,
          method: "config.get",
          params: {},
        }),
      );
      const current = await onceMessage<{
        ok: boolean;
        payload?: { config?: Record<string, unknown> };
      }>(ws, (o) => {
        const msg = o as { type?: string; id?: string };
        return msg.type === "res" && msg.id === getId;
      });
      expect(current.ok).toBe(true);
      const nextConfig = structuredClone(current.payload?.config ?? {});
      const channels = (nextConfig.channels ??= {}) as Record<string, unknown>;
      const telegram = (channels.telegram ??= {}) as Record<string, unknown>;
      telegram.botToken = { source: "env", provider: "default", id: missingEnvVar };
      const telegramAccounts = (telegram.accounts ??= {}) as Record<string, unknown>;
      const defaultTelegramAccount = (telegramAccounts.default ??= {}) as Record<string, unknown>;
      defaultTelegramAccount.enabled = true;

      const id = "req-secretref-apply";
      const res = await sendConfigApply(ws, id, JSON.stringify(nextConfig, null, 2));
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
    } finally {
      ws.close();
    }
  });

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
});
