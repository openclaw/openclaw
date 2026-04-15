import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";

const resolveGatewayScopedToolsMock = vi.hoisted(() =>
  vi.fn(() => ({
    agentId: "main",
    tools: [
      {
        name: "message",
        description: "send a message",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      },
    ],
  })),
);

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ session: { mainKey: "main" } }),
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: Parameters<typeof resolveGatewayScopedToolsMock>) =>
    resolveGatewayScopedToolsMock(...args),
}));

import {
  createMcpLoopbackServerConfig,
  closeMcpLoopbackServer,
  ensureMcpLoopbackServer,
  getActiveMcpLoopbackRuntime,
  registerMcpLoopbackToken,
  startMcpLoopbackServer,
  unregisterMcpLoopbackToken,
} from "./mcp-http.js";

let server: Awaited<ReturnType<typeof startMcpLoopbackServer>> | undefined;
const registeredTokensForTest: string[] = [];

function registerTokenForTest(scope: Parameters<typeof registerMcpLoopbackToken>[0]): string {
  const token = registerMcpLoopbackToken(scope);
  registeredTokensForTest.push(token);
  return token;
}

async function sendRaw(params: {
  port: number;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/mcp`, {
    method: "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...params.headers,
    },
    body: params.body,
  });
}

beforeEach(() => {
  resolveGatewayScopedToolsMock.mockClear();
  resolveGatewayScopedToolsMock.mockReturnValue({
    agentId: "main",
    tools: [
      {
        name: "message",
        description: "send a message",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      },
    ],
  });
});

afterEach(async () => {
  for (const token of registeredTokensForTest.splice(0)) {
    unregisterMcpLoopbackToken(token);
  }
  await server?.close();
  server = undefined;
});

describe("mcp loopback server", () => {
  it("resolves scope from the registered token rather than request headers", async () => {
    const port = await getFreePortBlockWithPermissionFallback({
      offsets: [0],
      fallbackBase: 53_000,
    });
    server = await startMcpLoopbackServer(port);
    const token = registerTokenForTest({
      sessionKey: "agent:main:telegram:group:chat123",
      accountId: "work",
      messageProvider: "telegram",
      senderIsOwner: false,
    });

    const response = await sendRaw({
      port: server.port,
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:group:chat123",
        accountId: "work",
        messageProvider: "telegram",
        senderIsOwner: false,
        surface: "loopback",
      }),
    );
  });

  it("non-owner token cannot elevate to owner via x-openclaw-sender-is-owner", async () => {
    server = await startMcpLoopbackServer(0);
    const token = registerTokenForTest({
      sessionKey: "agent:main:matrix:dm:owner-key",
      accountId: "real-account",
      messageProvider: "matrix",
      senderIsOwner: false,
    });

    const response = await sendRaw({
      port: server.port,
      token,
      headers: {
        "content-type": "application/json",
        "x-openclaw-sender-is-owner": "true",
        "x-session-key": "attacker-key",
        "x-openclaw-account-id": "attacker-account",
        "x-openclaw-message-channel": "attacker-channel",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:matrix:dm:owner-key",
        accountId: "real-account",
        messageProvider: "matrix",
        senderIsOwner: false,
        surface: "loopback",
      }),
    );
  });

  it("independent tokens produce independent scopes", async () => {
    server = await startMcpLoopbackServer(0);
    const ownerToken = registerTokenForTest({
      sessionKey: "agent:main:matrix:dm:test",
      accountId: undefined,
      messageProvider: "matrix",
      senderIsOwner: true,
    });
    const nonOwnerToken = registerTokenForTest({
      sessionKey: "agent:main:matrix:dm:test",
      accountId: undefined,
      messageProvider: "matrix",
      senderIsOwner: false,
    });

    const activeServer = server;
    const sendToolsList = async (token: string) =>
      await sendRaw({
        port: activeServer.port,
        token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    expect((await sendToolsList(ownerToken)).status).toBe(200);
    expect((await sendToolsList(nonOwnerToken)).status).toBe(200);

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
    expect(resolveGatewayScopedToolsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: "agent:main:matrix:dm:test",
        messageProvider: "matrix",
        senderIsOwner: true,
        surface: "loopback",
      }),
    );
    expect(resolveGatewayScopedToolsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: "agent:main:matrix:dm:test",
        messageProvider: "matrix",
        senderIsOwner: false,
        surface: "loopback",
      }),
    );
  });

  it("returns 401 when the bearer token is not registered", async () => {
    server = await startMcpLoopbackServer(0);
    const response = await sendRaw({
      port: server.port,
      token: "a".repeat(64),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("unregisterMcpLoopbackToken invalidates cached scoped tools", async () => {
    server = await startMcpLoopbackServer(0);
    const scope = {
      sessionKey: "agent:main:matrix:dm:revoke",
      accountId: undefined,
      messageProvider: "matrix" as const,
      senderIsOwner: false,
    };
    const token = registerMcpLoopbackToken(scope);

    const first = await sendRaw({
      port: server.port,
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(first.status).toBe(200);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);

    unregisterMcpLoopbackToken(token);

    const afterRevoke = await sendRaw({
      port: server.port,
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(afterRevoke.status).toBe(401);

    const reusedToken = registerTokenForTest({
      sessionKey: scope.sessionKey,
      accountId: scope.accountId,
      messageProvider: scope.messageProvider,
      senderIsOwner: true,
    });
    const reissued = await sendRaw({
      port: server.port,
      token: reusedToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(reissued.status).toBe(200);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
    expect(resolveGatewayScopedToolsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionKey: scope.sessionKey,
        senderIsOwner: true,
      }),
    );
  });

  it("tracks the active runtime only while the server is running", async () => {
    server = await startMcpLoopbackServer(0);
    const active = getActiveMcpLoopbackRuntime();
    expect(active?.port).toBe(server.port);

    await server.close();
    server = undefined;
    expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
  });

  it("starts the loopback server lazily and reuses the same singleton", async () => {
    expect(getActiveMcpLoopbackRuntime()).toBeUndefined();

    const first = await ensureMcpLoopbackServer(0);
    const second = await ensureMcpLoopbackServer(0);

    expect(second).toBe(first);
    expect(getActiveMcpLoopbackRuntime()?.port).toBe(first.port);

    await closeMcpLoopbackServer();
    expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
  });

  it("returns 401 when the bearer token is missing", async () => {
    server = await startMcpLoopbackServer(0);
    const response = await sendRaw({
      port: server.port,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 415 when the content type is not JSON", async () => {
    server = await startMcpLoopbackServer(0);
    const token = registerTokenForTest({
      sessionKey: "agent:main:main",
      accountId: undefined,
      messageProvider: undefined,
      senderIsOwner: false,
    });
    const response = await sendRaw({
      port: server.port,
      token,
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(response.status).toBe(415);
  });

  it("rejects cross-origin browser requests before auth", async () => {
    server = await startMcpLoopbackServer(0);
    const response = await sendRaw({
      port: server.port,
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects non-loopback origins even without fetch metadata", async () => {
    server = await startMcpLoopbackServer(0);
    const response = await sendRaw({
      port: server.port,
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(403);
  });

  it("allows loopback browser origins for local clients", async () => {
    server = await startMcpLoopbackServer(0);
    const token = registerTokenForTest({
      sessionKey: "agent:main:main",
      accountId: undefined,
      messageProvider: undefined,
      senderIsOwner: false,
    });
    const response = await sendRaw({
      port: server.port,
      token,
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:43123",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
  });

  it("allows same-origin browser requests from loopback clients", async () => {
    server = await startMcpLoopbackServer(0);
    const token = registerTokenForTest({
      sessionKey: "agent:main:main",
      accountId: undefined,
      messageProvider: undefined,
      senderIsOwner: false,
    });
    const response = await sendRaw({
      port: server.port,
      token,
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${server.port}`,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
  });

  it("allows cross-site fetch metadata when both ends are loopback (localhost ↔ 127.0.0.1)", async () => {
    // Browsers report a request from a `http://localhost:<ui-port>`
    // page to `http://127.0.0.1:<mcp-port>` as Sec-Fetch-Site:
    // cross-site even though both ends are loopback. The gate must
    // not blanket-reject on the cross-site signal — checkBrowserOrigin
    // already authorizes loopback origins from loopback peers via
    // its `local-loopback` matcher.
    server = await startMcpLoopbackServer(0);
    const token = registerTokenForTest({
      sessionKey: "agent:main:main",
      accountId: undefined,
      messageProvider: undefined,
      senderIsOwner: false,
    });
    const response = await sendRaw({
      port: server.port,
      token,
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:43123",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
  });
});

describe("createMcpLoopbackServerConfig", () => {
  it("emits only the authorization and agent-id headers", () => {
    const config = createMcpLoopbackServerConfig(23119) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(config.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    const headers = config.mcpServers?.openclaw?.headers ?? {};
    expect(headers.Authorization).toBe("Bearer ${OPENCLAW_MCP_TOKEN}");
    expect(headers["x-openclaw-agent-id"]).toBe("${OPENCLAW_MCP_AGENT_ID}");
    expect(headers["x-session-key"]).toBeUndefined();
    expect(headers["x-openclaw-account-id"]).toBeUndefined();
    expect(headers["x-openclaw-message-channel"]).toBeUndefined();
    expect(headers["x-openclaw-sender-is-owner"]).toBeUndefined();
  });
});

describe("registerMcpLoopbackToken", () => {
  it("mints unique hex tokens per registration", () => {
    const tokenA = registerTokenForTest({
      sessionKey: "agent:main:main",
      accountId: undefined,
      messageProvider: undefined,
      senderIsOwner: false,
    });
    const tokenB = registerTokenForTest({
      sessionKey: "agent:main:main",
      accountId: undefined,
      messageProvider: undefined,
      senderIsOwner: true,
    });
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenB).toMatch(/^[0-9a-f]{64}$/);
  });

  it("unregister is idempotent", () => {
    const token = registerMcpLoopbackToken({
      sessionKey: "agent:main:main",
      accountId: undefined,
      messageProvider: undefined,
      senderIsOwner: false,
    });
    expect(() => {
      unregisterMcpLoopbackToken(token);
      unregisterMcpLoopbackToken(token);
    }).not.toThrow();
  });
});
