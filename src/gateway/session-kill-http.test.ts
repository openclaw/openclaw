import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";

let cfg: Record<string, unknown> = {};
const authMock = vi.fn(async () => ({ ok: true }));
const loadSessionEntryMock = vi.fn();
const killSubagentRunAdminMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => cfg,
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: (...args: unknown[]) => authMock(...args),
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (...args: unknown[]) => killSubagentRunAdminMock(...args),
}));

const { handleSessionKillHttpRequest } = await import("./session-kill-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleSessionKillHttpRequest(req, res, {
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
  loadSessionEntryMock.mockReset();
  killSubagentRunAdminMock.mockReset();
});

async function post(pathname: string, token = TEST_GATEWAY_TOKEN) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers,
  });
}

describe("POST /sessions/:sessionKey/kill", () => {
  it("returns 401 when auth fails", async () => {
    authMock.mockResolvedValueOnce({ ok: false, rateLimited: false });

    const response = await post("/sessions/agent%3Amain%3Asubagent%3Aworker/kill");
    expect(response.status).toBe(401);
  });

  it("returns 404 when the session key is not in the session store", async () => {
    loadSessionEntryMock.mockReturnValue({ entry: undefined });

    const response = await post("/sessions/agent%3Amain%3Asubagent%3Aworker/kill");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { type: "not_found" },
    });
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("kills a matching session via the admin kill helper", async () => {
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
    });
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: true });

    const response = await post("/sessions/agent%3Amain%3Asubagent%3Aworker/kill");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: true });
    expect(killSubagentRunAdminMock).toHaveBeenCalledWith({
      cfg,
      sessionKey: "agent:main:subagent:worker",
    });
  });

  it("returns killed=false when the target exists but nothing was stopped", async () => {
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
    });
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: false });

    const response = await post("/sessions/agent%3Amain%3Asubagent%3Aworker/kill");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: false });
  });
});
