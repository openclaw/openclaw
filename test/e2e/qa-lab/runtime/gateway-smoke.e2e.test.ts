import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
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
  const smokeOptions = { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" };
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

  async function listenGatewaySmokeServer() {
    const requests: Array<{ method: string; params?: unknown; timeout?: number }> = [];
    server = createServer();
    wss = new WebSocketServer({ server });
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (data: RawData) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : data.toString("utf8");
        const frame = JSON.parse(text) as {
          id: string;
          method: string;
          params?: unknown;
          type: string;
        };
        requests.push({ method: frame.method, params: frame.params });
        const reply = (result: Record<string, unknown>) =>
          ws.send(JSON.stringify({ id: frame.id, type: "res", ...result }));
        if (frame.method === "connect") {
          reply(connectHelloResponse());
          return;
        }
        if (frame.method === "health") {
          reply(healthResponse());
          return;
        }
        reply({ error: `unexpected method ${frame.method}`, ok: false });
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test gateway smoke server did not get a TCP address");
    }
    return { requests, url: `ws://127.0.0.1:${address.port}` };
  }

  function createSmokeDeps(
    responses: Partial<Record<string, { error?: string; ok: boolean } & Record<string, unknown>>>,
    calls: Array<{ method: string; timeout?: number }> = [],
  ) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let closed = 0;

    return {
      calls,
      get closed() {
        return closed;
      },
      stderr,
      stdout,
      deps: {
        createClient: () =>
          ({
            close: () => {
              closed += 1;
            },
            request: async (method: string, _params?: unknown, timeout?: number) => {
              calls.push({ method, timeout });
              const response = responses[method];
              return {
                id: method,
                ...response,
                ok: response?.ok ?? false,
                error: response?.error,
                type: "res",
              };
            },
            waitOpen: async () => {},
          }) as never,
        stderr: (message: string) => {
          stderr.push(message);
        },
        stdout: (message: string) => {
          stdout.push(message);
        },
      },
    };
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

  it("passes against a loopback gateway websocket using the real client", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const loopback = await listenGatewaySmokeServer();

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: loopback.url },
      {
        stderr: (message) => {
          stderr.push(message);
        },
        stdout: (message) => {
          stdout.push(message);
        },
      },
    );

    expect(code).toBe(0);
    expect(loopback.requests.map((request) => request.method)).toEqual(["connect", "health"]);
    expect(loopback.requests[0]?.params).toMatchObject({
      auth: { token: "secret-token" },
      client: { id: "openclaw-ios" },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    expect(stdout).toEqual(["ok: connected + health"]);
    expect(stderr).toEqual([]);
  });

  it.each([
    {
      name: "closes the client when connect fails",
      responses: { connect: { ok: false, error: "bad token" } },
      code: 2,
      methods: ["connect"],
      error: "connect failed: bad token",
    },
    {
      name: "requires connect and health in order",
      responses: { connect: connectHelloResponse(), health: healthResponse() },
      code: 0,
      methods: ["connect", "health"],
      error: undefined,
    },
    {
      name: "rejects missing hello evidence",
      responses: { connect: { ok: true } },
      code: 2,
      methods: ["connect"],
      error: "connect failed: missing hello-ok payload",
    },
    {
      name: "rejects unpaired iOS operator scopes",
      responses: { connect: connectHelloResponse(["operator.read"]) },
      code: 2,
      methods: ["connect"],
      error: "connect failed: unpaired iOS smoke unexpectedly received operator scopes",
    },
    {
      name: "rejects missing health summary evidence",
      responses: { connect: connectHelloResponse(), health: { ok: true } },
      code: 3,
      methods: ["connect", "health"],
      error: "health failed: missing health summary payload",
    },
  ])("$name", async ({ responses, code, methods, error }) => {
    const fake = createSmokeDeps(responses);
    expect(await runGatewaySmoke(smokeOptions, fake.deps)).toBe(code);
    expect(fake).toMatchObject({
      closed: 1,
      stdout: error ? [] : ["ok: connected + health"],
      stderr: error ? [error] : [],
    });
    expect(fake.calls).toEqual(methods.map((method) => ({ method, timeout: undefined })));
  });
});
