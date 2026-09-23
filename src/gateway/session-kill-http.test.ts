// Session kill HTTP tests cover subagent kill authorization, requester/admin
// scope handling, local request checks, and error responses.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "./auth.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";
const WORKER_SESSION_KEY = "agent:main:subagent:worker";
const WORKER_KILL_PATH = "/sessions/agent%3Amain%3Asubagent%3Aworker/kill";
const ADMIN_SCOPE_HEADERS = {
  "x-openclaw-scopes": "operator.admin",
};
const REQUESTER_WRITE_HEADERS = {
  "x-openclaw-scopes": "operator.write",
  "x-openclaw-requester-session-key": "agent:main:main",
};
const REQUESTER_ADMIN_HEADERS = {
  "x-openclaw-scopes": "operator.admin",
  "x-openclaw-requester-session-key": "agent:other:main",
};

let cfg: OpenClawConfig = {};
let resolvedAuth: ResolvedGatewayAuth;
const authMock = vi.fn(async (): Promise<GatewayAuthResult> => ({ ok: true }));
const loadSessionEntryMock = vi.fn();
const killSubagentRunAdminMock = vi.fn();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: authMock,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
}));

vi.mock("../agents/subagents/registry/subagent-control.js", () => ({
  killSubagentRunAdmin: killSubagentRunAdminMock,
}));

const { handleSessionKillHttpRequest } = await import("./session-kill-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleSessionKillHttpRequest(req, res, {
      auth: resolvedAuth,
      cfg,
      getRuntimeConfig: () => cfg,
      getResolvedAuth: () => resolvedAuth,
    })
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end("not found");
        }
      })
      .catch(() => finishFailedGatewayHttpResponse(res));
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
  resolvedAuth = { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false };
  authMock.mockReset();
  authMock.mockResolvedValue({ ok: true, method: "token" });
  loadSessionEntryMock.mockReset();
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

function postWorkerKill(token = TEST_GATEWAY_TOKEN, extraHeaders?: Record<string, string>) {
  return post(WORKER_KILL_PATH, token, extraHeaders);
}

function allowTrustedProxyAuth() {
  authMock.mockResolvedValueOnce({ ok: true, method: "trusted-proxy" });
}

function mockWorkerSession() {
  loadSessionEntryMock.mockReturnValue({
    entry: { sessionId: "sess-worker", updatedAt: Date.now() },
    canonicalKey: WORKER_SESSION_KEY,
  });
}

async function expectForbiddenMissingScope(response: Response, message: string) {
  expect(response.status).toBe(403);
  expectErrorResponse(await response.json(), {
    type: "forbidden",
    message,
  });
}

function expectErrorResponse(body: unknown, expected: { type: string; message?: string }) {
  const response = body as {
    ok?: unknown;
    error?: { type?: unknown; message?: unknown };
  };
  if (Object.hasOwn(response, "ok")) {
    expect(response.ok).toBe(false);
  }
  expect(response.error?.type).toBe(expected.type);
  if (expected.message !== undefined) {
    expect(response.error?.message).toBe(expected.message);
  }
}

describe("POST /sessions/:sessionKey/kill", () => {
  it("returns 401 when auth fails", async () => {
    authMock.mockResolvedValueOnce({ ok: false, rateLimited: false });

    const response = await postWorkerKill();
    expect(response.status).toBe(401);
  });

  it("returns 404 when the session key is not in the session store", async () => {
    allowTrustedProxyAuth();
    loadSessionEntryMock.mockReturnValue({ entry: undefined });

    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
    expect(response.status).toBe(404);
    expectErrorResponse(await response.json(), { type: "not_found" });
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("matches kill paths without trusting malformed Host headers", async () => {
    allowTrustedProxyAuth();
    loadSessionEntryMock.mockReturnValue({ entry: undefined });

    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, {
      Host: "[",
      ...ADMIN_SCOPE_HEADERS,
    });
    expect(response.status).toBe(404);
    expectErrorResponse(await response.json(), { type: "not_found" });
    expect(loadSessionEntryMock).toHaveBeenCalled();
  });

  it.each(["/sessions/%zz/kill", "/sessions/%20/kill"])(
    "rejects invalid encoded session key %s without falling through",
    async (pathname) => {
      const response = await post(pathname);
      expect(response.status).toBe(400);
      expectErrorResponse(await response.json(), {
        message: "invalid session key",
        type: "invalid_request_error",
      });
      expect(authMock).not.toHaveBeenCalled();
      expect(loadSessionEntryMock).not.toHaveBeenCalled();
      expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
    },
  );

  it("kills a matching session via the admin kill helper using the canonical key", async () => {
    allowTrustedProxyAuth();
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
      canonicalKey: WORKER_SESSION_KEY,
    });
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: true });

    const response = await post(
      "/sessions/agent%3AMain%3ASubagent%3AWorker/kill",
      TEST_GATEWAY_TOKEN,
      {
        "x-openclaw-scopes": "operator.admin",
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: true });
    expect(killSubagentRunAdminMock.mock.calls[0]?.[0]).toEqual({
      cfg,
      sessionKey: WORKER_SESSION_KEY,
      agentId: "main",
    });
  });

  it("returns killed=false when the target exists but nothing was stopped", async () => {
    allowTrustedProxyAuth();
    mockWorkerSession();
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: false });

    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: false });
  });

  it.each(["unchanged settings", "policy revocation", "credential rotation"] as const)(
    "checks HTTP kill authority after %s",
    async (change) => {
      allowTrustedProxyAuth();
      mockWorkerSession();
      const entered = createDeferred();
      const release = createDeferred();
      const cancel = vi.fn();
      killSubagentRunAdminMock.mockImplementationOnce(
        async (_params: unknown, control: Parameters<typeof killSubagentRunAdmin>[1]) => {
          entered.resolve();
          await release.promise;
          control?.assertCurrent();
          cancel();
          return { found: true, killed: true };
        },
      );
      const responsePromise = postWorkerKill(TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
      try {
        await Promise.race([
          entered.promise,
          responsePromise.then(() => {
            throw new Error("kill returned before cancellation preparation");
          }),
        ]);
        if (change === "policy revocation") {
          cfg = { gateway: { auth: { allowTailscale: true } } };
        } else if (change === "credential rotation") {
          resolvedAuth = { ...resolvedAuth, token: "rotated-test-gateway-token" };
        }
      } finally {
        release.resolve();
      }
      const response = await responsePromise;
      const authorized = change === "unchanged settings";
      expect(response.status).toBe(authorized ? 200 : 401);
      expect(cancel).toHaveBeenCalledTimes(authorized ? 1 : 0);
      await expect(response.json()).resolves.toMatchObject(
        authorized ? { ok: true, killed: true } : { error: { type: "unauthorized" } },
      );
    },
  );

  it("preserves failures from an authorized kill", async () => {
    allowTrustedProxyAuth();
    mockWorkerSession();
    killSubagentRunAdminMock.mockRejectedValueOnce(new Error("cancellation failed"));

    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Internal Server Error");
  });

  it("rejects local bearer-auth kills without a trusted admin scope surface", async () => {
    const response = await postWorkerKill();
    await expectForbiddenMissingScope(response, "missing scope: operator.admin");
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("does not trust x-openclaw-scopes on shared-secret bearer auth", async () => {
    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
    await expectForbiddenMissingScope(response, "missing scope: operator.admin");
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("rejects bearer-auth kills without a trusted admin scope surface", async () => {
    mockWorkerSession();

    const response = await postWorkerKill();
    expect(response.status).toBe(403);
    expectErrorResponse(await response.json(), { type: "forbidden" });
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("rejects trusted-proxy requester-session kills without admin scope", async () => {
    allowTrustedProxyAuth();
    const response = await postWorkerKill("", REQUESTER_WRITE_HEADERS);
    await expectForbiddenMissingScope(response, "missing scope: operator.admin");
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("uses the admin kill path even when the requester session header is present", async () => {
    allowTrustedProxyAuth();
    mockWorkerSession();
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: true });

    const response = await postWorkerKill("", REQUESTER_ADMIN_HEADERS);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: true });
    expect(killSubagentRunAdminMock.mock.calls[0]?.[0]).toEqual({
      cfg,
      sessionKey: WORKER_SESSION_KEY,
      agentId: "main",
    });
  });

  it("rejects bearer-auth requester kills without a trusted admin scope surface", async () => {
    const response = await post(
      "/sessions/agent%3Amain%3Asubagent%3Aworker/kill",
      TEST_GATEWAY_TOKEN,
      { "x-openclaw-requester-session-key": "agent:other:main" },
    );
    expect(response.status).toBe(403);
    expectErrorResponse(await response.json(), {
      type: "forbidden",
      message: "missing scope: operator.admin",
    });
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });
});
