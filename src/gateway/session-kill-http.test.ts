import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";

let cfg: Record<string, unknown> = {};
const authMock = vi.fn(async () => ({ ok: true }));
const isLocalDirectRequestMock = vi.fn(() => true);
const loadSessionEntryMock = vi.fn();
const getSubagentRunByChildSessionKeyMock = vi.fn();
const resolveSubagentControllerMock = vi.fn();
const killControlledSubagentRunMock = vi.fn();
const killSubagentRunAdminMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => cfg,
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: (...args: unknown[]) => authMock(...args),
  isLocalDirectRequest: (...args: unknown[]) => isLocalDirectRequestMock(...args),
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
}));

vi.mock("../agents/subagent-registry.js", () => ({
  getSubagentRunByChildSessionKey: (...args: unknown[]) =>
    getSubagentRunByChildSessionKeyMock(...args),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killControlledSubagentRun: (...args: unknown[]) => killControlledSubagentRunMock(...args),
  killSubagentRunAdmin: (...args: unknown[]) => killSubagentRunAdminMock(...args),
  resolveSubagentController: (...args: unknown[]) => resolveSubagentControllerMock(...args),
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
  isLocalDirectRequestMock.mockReset();
  isLocalDirectRequestMock.mockReturnValue(true);
  loadSessionEntryMock.mockReset();
  getSubagentRunByChildSessionKeyMock.mockReset();
  resolveSubagentControllerMock.mockReset();
  resolveSubagentControllerMock.mockReturnValue({ controllerSessionKey: "agent:main:main" });
  killControlledSubagentRunMock.mockReset();
  killSubagentRunAdminMock.mockReset();
});

async function post(
  pathname: string,
  token = TEST_GATEWAY_TOKEN,
  extraHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  Object.assign(headers, extraHeaders ?? {});
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

  it("kills a matching session via the admin kill helper using the canonical key", async () => {
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
      canonicalKey: "agent:main:subagent:worker",
    });
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: true });

    const response = await post("/sessions/agent%3AMain%3ASubagent%3AWorker/kill");
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
      canonicalKey: "agent:main:subagent:worker",
    });
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: false });

    const response = await post("/sessions/agent%3Amain%3Asubagent%3Aworker/kill");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: false });
  });

  it("allows remote admin kills with an authorized bearer token", async () => {
    isLocalDirectRequestMock.mockReturnValue(false);
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
      canonicalKey: "agent:main:subagent:worker",
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

  it("rejects remote kills without requester ownership or an authorized token", async () => {
    isLocalDirectRequestMock.mockReturnValue(false);
    authMock.mockResolvedValueOnce({ ok: true });
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
      canonicalKey: "agent:main:subagent:worker",
    });

    const response = await post("/sessions/agent%3Amain%3Asubagent%3Aworker/kill", "", {
      authorization: "",
    });
    expect(response.status).toBe(403);
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("uses requester ownership checks when a requester session header is provided without admin bypass", async () => {
    isLocalDirectRequestMock.mockReturnValue(false);
    authMock.mockResolvedValueOnce({ ok: true });
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
      canonicalKey: "agent:main:subagent:worker",
    });
    getSubagentRunByChildSessionKeyMock.mockReturnValue({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:worker",
    });
    killControlledSubagentRunMock.mockResolvedValue({ status: "ok" });

    const response = await post("/sessions/agent%3Amain%3Asubagent%3Aworker/kill", "", {
      "x-openclaw-requester-session-key": "agent:main:main",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: true });
    expect(resolveSubagentControllerMock).toHaveBeenCalledWith({
      cfg,
      agentSessionKey: "agent:main:main",
    });
    expect(getSubagentRunByChildSessionKeyMock).toHaveBeenCalledWith("agent:main:subagent:worker");
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("prefers admin kill when a valid bearer token is present alongside requester headers", async () => {
    isLocalDirectRequestMock.mockReturnValue(false);
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
      canonicalKey: "agent:main:subagent:worker",
    });
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: true });

    const response = await post(
      "/sessions/agent%3Amain%3Asubagent%3Aworker/kill",
      TEST_GATEWAY_TOKEN,
      { "x-openclaw-requester-session-key": "agent:other:main" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: true });
    expect(killSubagentRunAdminMock).toHaveBeenCalledWith({
      cfg,
      sessionKey: "agent:main:subagent:worker",
    });
    expect(killControlledSubagentRunMock).not.toHaveBeenCalled();
  });
});
