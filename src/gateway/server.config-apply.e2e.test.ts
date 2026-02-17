import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  startGatewayServer,
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
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws);
  return ws;
};

describe("gateway config.apply", () => {
  it("rejects invalid raw config", async () => {
    const ws = await openClient();
    try {
      const id = "req-1";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "config.apply",
          params: {
            raw: "{",
          },
        }),
      );
      const res = await onceMessage<{ ok: boolean; error?: { message?: string } }>(
        ws,
        (o) => o.type === "res" && o.id === id,
      );
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
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "config.apply",
          params: {
            raw: { gateway: { mode: "local" } },
          },
        }),
      );
      const res = await onceMessage<{ ok: boolean; error?: { message?: string } }>(
        ws,
        (o) => o.type === "res" && o.id === id,
      );
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("raw");
    } finally {
      ws.close();
    }
  });
});
