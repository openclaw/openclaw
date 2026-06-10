// Tests for POST /api/mcp/servers/:serverId/reload HTTP endpoint.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAuthResult } from "./auth.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-mcp-reload";

let cfg: Record<string, unknown> = {};
const authMock = vi.fn(async (): Promise<GatewayAuthResult> => ({ ok: true }));
const listSessionIdsMock = vi.fn<() => string[]>(() => []);
const peekSessionMock = vi.fn<(params: { sessionId?: string; sessionKey?: string }) => unknown>(
  () => undefined,
);

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: authMock,
}));

vi.mock("../agents/agent-bundle-mcp-runtime.js", () => ({
  getSessionMcpRuntimeManager: () => ({
    listSessionIds: listSessionIdsMock,
    peekSession: peekSessionMock,
  }),
}));

const { handleMcpReloadHttpRequest } = await import("./mcp-reload-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleMcpReloadHttpRequest(req, res, {
      auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: { type: "not_found" } }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address() as AddressInfo | null;
      if (!address) {
        reject(new Error("server missing address"));
        return;
      }
      port = address.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  cfg = {};
  authMock.mockReset();
  authMock.mockResolvedValue({ ok: true, method: "token" });
  listSessionIdsMock.mockReset();
  listSessionIdsMock.mockReturnValue([]);
  peekSessionMock.mockReset();
  peekSessionMock.mockReturnValue(undefined);
});

async function post(
  pathname: string,
  token = TEST_GATEWAY_TOKEN,
  extraHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = {
    "x-openclaw-scopes": "operator.write",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  Object.assign(headers, extraHeaders ?? {});
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers,
  });
}

function makeReloadRuntime(serverName?: string): {
  reloadServer: ReturnType<typeof vi.fn>;
} {
  return {
    reloadServer: vi.fn(async (_name: string) => {
      if (serverName !== undefined && _name !== serverName) {
        throw new Error(`unexpected server name: ${_name}`);
      }
    }),
  };
}

// ─── path matching ────────────────────────────────────────────────────────────

describe("path matching", () => {
  it("returns false for unrelated paths", async () => {
    const res = await post("/tools/invoke");
    // The server returns 404 when handleMcpReloadHttpRequest returns false.
    expect(res.status).toBe(404);
  });

  it("returns 405 for GET requests", async () => {
    listSessionIdsMock.mockReturnValue([]);
    const res = await fetch(
      `http://127.0.0.1:${port}/api/mcp/servers/composio/reload`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_GATEWAY_TOKEN}`,
          "x-openclaw-scopes": "operator.write",
        },
      },
    );
    expect(res.status).toBe(405);
  });

  it("returns 404 for an unmatched nested path under /api/mcp/servers/", async () => {
    // Extra path segment after reload → the handler returns false → 404.
    const res = await post("/api/mcp/servers/composio/reload/extra");
    expect(res.status).toBe(404);
  });
});

// ─── auth ─────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("returns 401 for missing token", async () => {
    authMock.mockResolvedValueOnce({ ok: false, reason: "unauthorized" });
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/servers/composio/reload`, {
      method: "POST",
      headers: { "x-openclaw-scopes": "operator.write" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when operator scope is insufficient (trusted-proxy auth, read-only scope)", async () => {
    // For trusted-proxy auth, the x-openclaw-scopes header is honoured.
    // operator.read is insufficient for mcp.server.reload (requires write).
    authMock.mockResolvedValueOnce({ ok: true, method: "trusted-proxy" });
    listSessionIdsMock.mockReturnValue([]);
    const res = await post("/api/mcp/servers/composio/reload", TEST_GATEWAY_TOKEN, {
      "x-openclaw-scopes": "operator.read",
    });
    expect(res.status).toBe(403);
  });
});

// ─── successful reload ────────────────────────────────────────────────────────

describe("successful reload", () => {
  it("returns sessionCount: 0 when no sessions are active", async () => {
    listSessionIdsMock.mockReturnValue([]);
    const res = await post("/api/mcp/servers/composio/reload");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, serverName: "composio", sessionCount: 0 });
  });

  it("reloads all active sessions when no sessionId is provided", async () => {
    const runtime1 = makeReloadRuntime();
    const runtime2 = makeReloadRuntime();
    listSessionIdsMock.mockReturnValue(["sess-1", "sess-2"]);
    peekSessionMock.mockImplementation(({ sessionId }: { sessionId?: string }) => {
      if (sessionId === "sess-1") return runtime1;
      if (sessionId === "sess-2") return runtime2;
      return undefined;
    });

    const res = await post("/api/mcp/servers/composio/reload");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, serverName: "composio", sessionCount: 2 });
    expect(runtime1.reloadServer).toHaveBeenCalledWith("composio");
    expect(runtime2.reloadServer).toHaveBeenCalledWith("composio");
  });

  it("reloads only the targeted session when X-OpenClaw-Session-Id header is provided", async () => {
    const runtime1 = makeReloadRuntime();
    const runtime2 = makeReloadRuntime();
    listSessionIdsMock.mockReturnValue(["sess-1", "sess-2"]);
    peekSessionMock.mockImplementation(({ sessionId }: { sessionId?: string }) => {
      if (sessionId === "sess-1") return runtime1;
      if (sessionId === "sess-2") return runtime2;
      return undefined;
    });

    const res = await post("/api/mcp/servers/composio/reload", TEST_GATEWAY_TOKEN, {
      "x-openclaw-session-id": "sess-1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, serverName: "composio", sessionCount: 1 });
    expect(runtime1.reloadServer).toHaveBeenCalledWith("composio");
    expect(runtime2.reloadServer).not.toHaveBeenCalled();
  });

  it("reloads the targeted session when sessionId query param is provided", async () => {
    const runtime = makeReloadRuntime();
    listSessionIdsMock.mockReturnValue(["sess-a"]);
    peekSessionMock.mockImplementation(({ sessionId }: { sessionId?: string }) => {
      if (sessionId === "sess-a") return runtime;
      return undefined;
    });

    const res = await post("/api/mcp/servers/my-mcp-server/reload?sessionId=sess-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, serverName: "my-mcp-server", sessionCount: 1 });
    expect(runtime.reloadServer).toHaveBeenCalledWith("my-mcp-server");
  });

  it("URL-decodes the server name from the path", async () => {
    const runtime = makeReloadRuntime();
    listSessionIdsMock.mockReturnValue(["sess-x"]);
    peekSessionMock.mockReturnValue(runtime);

    const res = await post("/api/mcp/servers/my%20server/reload");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, serverName: "my server" });
    expect(runtime.reloadServer).toHaveBeenCalledWith("my server");
  });

  it("gracefully skips runtimes that lack the reloadServer method", async () => {
    const legacyRuntime = {}; // no reloadServer
    listSessionIdsMock.mockReturnValue(["sess-legacy"]);
    peekSessionMock.mockReturnValue(legacyRuntime);

    const res = await post("/api/mcp/servers/composio/reload");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, sessionCount: 0 });
  });
});

// ─── error cases ──────────────────────────────────────────────────────────────

describe("error cases", () => {
  it("returns 404 when the targeted sessionId has no active runtime", async () => {
    listSessionIdsMock.mockReturnValue(["sess-other"]);
    peekSessionMock.mockReturnValue(undefined);

    const res = await post("/api/mcp/servers/composio/reload", TEST_GATEWAY_TOKEN, {
      "x-openclaw-session-id": "sess-missing",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect((body as { ok: boolean }).ok).toBe(false);
  });

  it("returns 500 when reloadServer throws for every session", async () => {
    const failingRuntime = {
      reloadServer: vi.fn(async () => {
        throw new Error("transport closed");
      }),
    };
    listSessionIdsMock.mockReturnValue(["sess-fail"]);
    peekSessionMock.mockReturnValue(failingRuntime);

    const res = await post("/api/mcp/servers/composio/reload");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect((body as { ok: boolean }).ok).toBe(false);
  });

  it("returns 200 with partialErrors when some sessions fail", async () => {
    const goodRuntime = makeReloadRuntime();
    const badRuntime = {
      reloadServer: vi.fn(async () => {
        throw new Error("net error");
      }),
    };
    listSessionIdsMock.mockReturnValue(["sess-good", "sess-bad"]);
    peekSessionMock.mockImplementation(({ sessionId }: { sessionId?: string }) => {
      if (sessionId === "sess-good") return goodRuntime;
      if (sessionId === "sess-bad") return badRuntime;
      return undefined;
    });

    const res = await post("/api/mcp/servers/composio/reload");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sessionCount: number; partialErrors: string[] };
    expect(body.ok).toBe(true);
    expect(body.sessionCount).toBe(1);
    expect(Array.isArray(body.partialErrors)).toBe(true);
    expect(body.partialErrors.length).toBe(1);
  });
});
