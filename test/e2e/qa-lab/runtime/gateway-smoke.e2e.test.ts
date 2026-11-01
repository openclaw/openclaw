import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { runGatewaySmoke } from "../../../../scripts/dev/gateway-smoke.js";

let server: Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  if (wss) {
    await new Promise<void>((resolve) => {
      wss?.close(() => resolve());
    });
  }
  wss = undefined;

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
  server = undefined;
});

describe("gateway-smoke", () => {
  function expectCliError(args: string[], message: string) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/gateway-smoke.ts", ...args],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(message);
  }

  function healthResponse() {
    return {
      ok: true,
      payload: {
        agents: [],
        channelOrder: [],
        channels: {},
        defaultAgentId: "codex",
        durationMs: 3,
        ok: true,
        sessions: {},
        ts: Date.now(),
      },
    };
  }

  function connectHelloResponse(scopes: string[] = []) {
    return {
      ok: true,
      payload: {
        auth: { role: "operator", scopes },
        features: { events: [], methods: ["health"] },
        protocol: 1,
        type: "hello-ok",
      },
    };
  }

  async function listenGatewaySmokeServer(responses: Record<string, object | undefined>) {
    const requests: Array<{ method: string; params?: unknown }> = [];
    server = createServer();
    wss = new WebSocketServer({ server });
    const closed = new Promise<void>((resolve) => {
      wss?.once("connection", (socket) => {
        socket.once("close", () => resolve());
      });
    });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as {
          id: string;
          method: string;
          params?: unknown;
          type: string;
        };
        requests.push({ method: frame.method, params: frame.params });
        ws.send(JSON.stringify({ id: frame.id, type: "res", ...responses[frame.method] }));
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test gateway smoke server did not get a TCP address");
    }
    return { requests, closed, url: `ws://127.0.0.1:${address.port}` };
  }

  it("rejects unknown CLI args before connecting", () => {
    expectCliError(
      ["--url", "ws://127.0.0.1:9", "--token", "token", "--wat"],
      "Unknown argument: --wat",
    );
  });

  it("rejects option-looking CLI values before connecting", () => {
    for (const [flag, args] of [
      ["--url", ["--url", "-h", "--token", "token"]],
      ["--token", ["--url", "ws://127.0.0.1:9", "--token", "-h"]],
    ] as const) {
      expectCliError([...args], `${flag} requires a value`);
    }
  });

  it("rejects duplicate CLI args before connecting", () => {
    for (const [flag, args] of [
      ["--url", ["--url", "ws://127.0.0.1:9", "--url", "ws://127.0.0.1:10", "--token", "token"]],
      ["--token", ["--url", "ws://127.0.0.1:9", "--token", "one", "--token", "two"]],
      ["--help", ["--help", "--help"]],
    ] as const) {
      expectCliError([...args], `${flag} was provided more than once`);
    }
  });

  it.each([
    ["bad token", { ok: false, error: "bad token" }, undefined, 2, "connect failed: bad token"],
    ["healthy gateway", connectHelloResponse(), healthResponse(), 0, undefined],
    ["missing hello", { ok: true }, undefined, 2, "connect failed: missing hello-ok payload"],
    [
      "unpaired iOS operator scopes",
      connectHelloResponse(["operator.read"]),
      undefined,
      2,
      "connect failed: unpaired iOS smoke unexpectedly received operator scopes",
    ],
    [
      "missing health summary",
      connectHelloResponse(),
      { ok: true },
      3,
      "health failed: missing health summary payload",
    ],
  ] as const)(
    "checks %s and closes the real client",
    async (_name, connect, health, code, error) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const loopback = await listenGatewaySmokeServer({ connect, health });
      expect(
        await runGatewaySmoke(
          { token: "secret-token", urlRaw: loopback.url },
          {
            stdout: (message) => {
              stdout.push(message);
            },
            stderr: (message) => {
              stderr.push(message);
            },
          },
        ),
      ).toBe(code);
      await loopback.closed;
      expect({ stdout, stderr }).toEqual({
        stdout: error ? [] : ["ok: connected + health"],
        stderr: error ? [error] : [],
      });
      expect(loopback.requests.map((request) => request.method)).toEqual(
        health ? ["connect", "health"] : ["connect"],
      );
      expect(loopback.requests[0]?.params).toMatchObject({
        auth: { token: "secret-token" },
        client: { id: "openclaw-ios" },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
      });
    },
  );
});
