import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";

let cfg: Record<string, unknown> = {};
const authMock = vi.fn(async () => ({ ok: true }) as { ok: boolean; rateLimited?: boolean });
const loadCombinedSessionStoreForGatewayMock = vi.fn(() => ({
  storePath: "/tmp/sessions.json",
  store: {} as Record<string, unknown>,
}));
const listSessionsFromStoreMock = vi.fn(() => ({
  ts: Date.now(),
  path: "/tmp/sessions.json",
  count: 0,
  defaults: { modelProvider: null, model: null, contextTokens: null },
  sessions: [],
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => cfg,
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: authMock,
}));

vi.mock("./session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: loadCombinedSessionStoreForGatewayMock,
  listSessionsFromStore: listSessionsFromStoreMock,
}));

const { handleSessionsListHttpRequest } = await import("./sessions-list-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleSessionsListHttpRequest(req, res, {
      auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
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
  authMock.mockResolvedValue({ ok: true });
  loadCombinedSessionStoreForGatewayMock.mockReset();
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "/tmp/sessions.json",
    store: {},
  });
  listSessionsFromStoreMock.mockReset();
  listSessionsFromStoreMock.mockReturnValue({
    ts: Date.now(),
    path: "/tmp/sessions.json",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  });
});

function get(pathname: string, token?: string | null) {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers.Authorization = `Bearer ${token ?? TEST_GATEWAY_TOKEN}`;
  }
  return fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
}

describe("GET /api/sessions", () => {
  it("returns false for non-matching paths", async () => {
    const res = await get("/api/other");
    // The test server sends 404 when the handler returns false
    expect(res.status).toBe(404);
    expect(authMock).not.toHaveBeenCalled();
  });

  it("returns 405 for POST method", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_GATEWAY_TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("returns 405 for PUT method", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_GATEWAY_TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("returns 401 when auth fails", async () => {
    authMock.mockResolvedValueOnce({ ok: false, rateLimited: false });

    const res = await get("/api/sessions");
    expect(res.status).toBe(401);
    expect(listSessionsFromStoreMock).not.toHaveBeenCalled();
  });

  it("returns 401 without auth token", async () => {
    authMock.mockResolvedValueOnce({ ok: false, rateLimited: false });

    const res = await get("/api/sessions", null);
    expect(res.status).toBe(401);
    expect(listSessionsFromStoreMock).not.toHaveBeenCalled();
  });

  it("returns 429 when rate-limited", async () => {
    authMock.mockResolvedValueOnce({ ok: false, rateLimited: true, retryAfterMs: 30_000 } as never);

    const res = await get("/api/sessions");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("returns session list with valid auth", async () => {
    const mockResult = {
      ts: 1700000000000,
      path: "/tmp/sessions.json",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-4", contextTokens: 4096 },
      sessions: [
        {
          key: "agent:main:main",
          updatedAt: 1700000000000,
          sessionId: "sess-main",
        },
      ],
    };
    listSessionsFromStoreMock.mockReturnValue(mockResult as never);

    const res = await get("/api/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockResult);
  });

  it("passes limit query parameter to listSessionsFromStore", async () => {
    await get("/api/sessions?limit=5");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts.limit).toBe(5);
  });

  it("passes activeMinutes query parameter", async () => {
    await get("/api/sessions?activeMinutes=30");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts.activeMinutes).toBe(30);
  });

  it("passes agentId query parameter", async () => {
    await get("/api/sessions?agentId=my-agent");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts.agentId).toBe("my-agent");
  });

  it("passes search query parameter", async () => {
    await get("/api/sessions?search=hello");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts.search).toBe("hello");
  });

  it("passes includeDerivedTitles boolean parameter", async () => {
    await get("/api/sessions?includeDerivedTitles=true");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts.includeDerivedTitles).toBe(true);
  });

  it("passes includeLastMessage boolean parameter", async () => {
    await get("/api/sessions?includeLastMessage=1");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts.includeLastMessage).toBe(true);
  });

  it("passes multiple query parameters together", async () => {
    await get("/api/sessions?limit=10&activeMinutes=60&agentId=test-agent&search=query");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts).toMatchObject({
      limit: 10,
      activeMinutes: 60,
      agentId: "test-agent",
      search: "query",
    });
  });

  it("ignores invalid integer parameters", async () => {
    await get("/api/sessions?limit=abc&activeMinutes=-5");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    // resolveIntParam returns undefined for non-finite or < 1 values
    expect(callArgs.opts.limit).toBeUndefined();
    expect(callArgs.opts.activeMinutes).toBeUndefined();
  });

  it("treats empty string parameters as undefined", async () => {
    await get("/api/sessions?limit=&agentId=&search=");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts.limit).toBeUndefined();
    expect(callArgs.opts.agentId).toBeUndefined();
    expect(callArgs.opts.search).toBeUndefined();
  });

  it("treats false-ish boolean values correctly", async () => {
    await get("/api/sessions?includeDerivedTitles=false&includeLastMessage=0");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      opts: Record<string, unknown>;
    };
    expect(callArgs.opts.includeDerivedTitles).toBe(false);
    expect(callArgs.opts.includeLastMessage).toBe(false);
  });

  it("forwards cfg and store info from loadCombinedSessionStoreForGateway", async () => {
    const mockStore = { "agent:main:main": { sessionId: "s1", updatedAt: 123 } };
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/custom/path/sessions.json",
      store: mockStore,
    });

    await get("/api/sessions");

    expect(listSessionsFromStoreMock).toHaveBeenCalledOnce();
    const callArgs = (listSessionsFromStoreMock.mock.calls as unknown[][])[0]?.[0] as {
      storePath: string;
      store: Record<string, unknown>;
    };
    expect(callArgs.storePath).toBe("/custom/path/sessions.json");
    expect(callArgs.store).toBe(mockStore);
  });
});
