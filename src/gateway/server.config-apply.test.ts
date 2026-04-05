import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { AUTH_PROFILE_FILENAME } from "../agents/auth-profiles/constants.js";
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

beforeEach(async () => {
  port = await getFreePort();
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

afterEach(async () => {
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
  const current = await sendConfigGet(ws, `${id}-base`);
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "config.apply",
      params: { raw, baseHash: current.payload?.hash },
    }),
  );
  return onceMessage<{ ok: boolean; error?: { message?: string } }>(ws, (o) => {
    const msg = o as { type?: string; id?: string };
    return msg.type === "res" && msg.id === id;
  });
};

const sendConfigGet = async (ws: WebSocket, id: string) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "config.get",
      params: {},
    }),
  );
  return onceMessage<{
    ok: boolean;
    payload?: { hash?: string; raw?: string | null; config?: Record<string, unknown> };
  }>(ws, (o) => {
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
      const current = await sendConfigGet(ws, "req-secretref-get-before");
      expect(current.ok).toBe(true);
      expect(typeof current.payload?.hash).toBe("string");
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

      const after = await sendConfigGet(ws, "req-secretref-get-after");
      expect(after.ok).toBe(true);
      expect(after.payload?.hash).toBe(current.payload?.hash);
      expect(after.payload?.raw).toBe(current.payload?.raw);
    } finally {
      ws.close();
    }
  });

  it("does not reject config.apply for unresolved auth-profile refs outside submitted config", async () => {
    const ws = await openClient();
    try {
      const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_APPLY_${Date.now()}`;
      delete process.env[missingEnvVar];

      const authStorePath = path.join(resolveOpenClawAgentDir(), AUTH_PROFILE_FILENAME);
      await fs.mkdir(path.dirname(authStorePath), { recursive: true });
      await fs.writeFile(
        authStorePath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "custom:token": {
                type: "token",
                provider: "custom",
                tokenRef: { source: "env", provider: "default", id: missingEnvVar },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const current = await sendConfigGet(ws, "req-auth-profile-get-before");
      expect(current.ok).toBe(true);
      expect(current.payload?.config).toBeTruthy();

      const res = await sendConfigApply(
        ws,
        "req-auth-profile-apply",
        JSON.stringify(current.payload?.config ?? {}, null, 2),
      );
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
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
