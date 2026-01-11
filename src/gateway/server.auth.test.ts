import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  formatValidationErrors,
  validateConnectParams,
} from "./protocol/index.js";
import {
  connectReq,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  startGatewayServer,
  startServerWithClient,
  testState,
} from "./test-helpers.js";
import { truncateCloseReason } from "./server.js";

installGatewayTestHooks();

describe("gateway server auth/connect", () => {
  test(
    "closes silent handshakes after timeout",
    { timeout: 15_000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 12_000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      expect(closed).toBe(true);
      await server.close();
    },
  );

  test("connect (req) handshake returns hello-ok payload", async () => {
    const { CONFIG_PATH_CLAWDBOT, STATE_DIR_CLAWDBOT } = await import(
      "../config/config.js"
    );
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const res = await connectReq(ws);
    expect(res.ok).toBe(true);
    const payload = res.payload as
      | {
          type?: unknown;
          snapshot?: { configPath?: string; stateDir?: string };
        }
      | undefined;
    expect(payload?.type).toBe("hello-ok");
    expect(payload?.snapshot?.configPath).toBe(CONFIG_PATH_CLAWDBOT);
    expect(payload?.snapshot?.stateDir).toBe(STATE_DIR_CLAWDBOT);

    ws.close();
    await server.close();
  });

  test("rejects protocol mismatch", async () => {
    const { server, ws } = await startServerWithClient();
    try {
      const res = await connectReq(ws, {
        minProtocol: PROTOCOL_VERSION + 1,
        maxProtocol: PROTOCOL_VERSION + 2,
      });
      expect(res.ok).toBe(false);
    } catch {
      // If the server closed before we saw the frame, that's acceptable.
    }
    ws.close();
    await server.close();
  });

  test("rejects invalid token", async () => {
    const { server, ws, prevToken } = await startServerWithClient("secret");
    const res = await connectReq(ws, { token: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("unauthorized");
    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = prevToken;
    }
  });

  test("accepts password auth when configured", async () => {
    testState.gatewayAuth = { mode: "password", password: "secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const res = await connectReq(ws, { password: "secret" });
    expect(res.ok).toBe(true);

    ws.close();
    await server.close();
  });

  test("rejects invalid password", async () => {
    testState.gatewayAuth = { mode: "password", password: "secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const res = await connectReq(ws, { password: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("unauthorized");

    ws.close();
    await server.close();
  });

  test("rejects non-connect first request", async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
    const res = await onceMessage<{ ok: boolean; error?: unknown }>(
      ws,
      (o) => o.type === "res" && o.id === "h1",
    );
    expect(res.ok).toBe(false);
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await server.close();
  });

  test("invalid connect params reason is truncated and descriptive", () => {
    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "bad-client",
        version: "dev",
        platform: "web",
        mode: "webchat",
      },
    };
    const ok = validateConnectParams(params as never);
    expect(ok).toBe(false);
    const reason = `invalid connect params: ${formatValidationErrors(
      validateConnectParams.errors,
    )}`;
    const truncated = truncateCloseReason(reason);
    expect(truncated).toContain("invalid connect params");
    expect(Buffer.from(truncated).length).toBeLessThanOrEqual(120);
  });
});
