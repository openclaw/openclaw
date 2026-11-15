import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "./auth.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";
const WORKER_SESSION_KEY = "agent:main:subagent:worker";
const WORKER_KILL_PATH = "/sessions/agent%3Amain%3Asubagent%3Aworker/kill";
const ADMIN_SCOPE_HEADERS = { "x-openclaw-scopes": "operator.admin" };
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

// mock-isolation: HTTP authorization cases use only the fixture's mutable config.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => cfg }));
// mock-isolation: Keep config reads inside the fixture rather than host configuration.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => cfg }));
// mock-isolation: Inject authorization outcomes at the HTTP handler boundary.
vi.mock("./auth.js", () => ({ authorizeHttpGatewayConnect: authMock }));

// mock-isolation: HTTP kill tests supply target rows without opening a session database.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: loadSessionEntryMock,
}));

vi.mock("../agents/subagents/registry/subagent-control.js", () => ({
  killSubagentRunAdmin: killSubagentRunAdminMock,
}));

const { handleSessionKillHttpRequest } = await import("./session-kill-http.js");

let port = 0;
let server: ReturnType<typeof createServer>;

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

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  cfg = {};
  resolvedAuth = { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false };
  authMock.mockReset().mockResolvedValue({ ok: true, method: "token" });
  loadSessionEntryMock.mockReset();
  killSubagentRunAdminMock.mockReset();
});

async function post(
  pathname = WORKER_KILL_PATH,
  token = TEST_GATEWAY_TOKEN,
  extraHeaders?: Record<string, string>,
) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
  });
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

async function expectError(response: Response, code: number, type: string, message?: string) {
  expect(response.status).toBe(code);
  const body: { ok?: unknown; error?: unknown } = await response.json();
  if (Object.hasOwn(body, "ok")) {
    expect(body.ok).toBe(false);
  }
  expect(body.error).toMatchObject(message === undefined ? { type } : { type, message });
}

it("returns 401 when auth fails", async () => {
  authMock.mockResolvedValueOnce({ ok: false, rateLimited: false });

  expect((await post()).status).toBe(401);
});

it("matches kill paths without trusting malformed Host headers", async () => {
  allowTrustedProxyAuth();
  loadSessionEntryMock.mockReturnValue({ entry: undefined });

  const response = await post(undefined, TEST_GATEWAY_TOKEN, {
    Host: "[",
    ...ADMIN_SCOPE_HEADERS,
  });
  await expectError(response, 404, "not_found");
  expect(loadSessionEntryMock).toHaveBeenCalled();
});

it.each(["/sessions/%zz/kill", "/sessions/%20/kill"])(
  "rejects invalid encoded session key %s without falling through",
  async (pathname) => {
    const response = await post(pathname);
    await expectError(response, 400, "invalid_request_error", "invalid session key");
    expect(authMock).not.toHaveBeenCalled();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  },
);

it.each([false, true])("uses canonical admin kill with requester header=%s", async (requester) => {
  allowTrustedProxyAuth();
  mockWorkerSession();
  killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: true });

  const path = requester ? WORKER_KILL_PATH : "/sessions/agent%3AMain%3ASubagent%3AWorker/kill";
  const headers = requester ? REQUESTER_ADMIN_HEADERS : ADMIN_SCOPE_HEADERS;
  const response = await post(path, requester ? "" : TEST_GATEWAY_TOKEN, headers);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, killed: true });
  expect(killSubagentRunAdminMock.mock.calls[0]?.[0]).toEqual({
    cfg,
    sessionKey: WORKER_SESSION_KEY,
    agentId: "main",
  });
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
    const responsePromise = post(undefined, TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
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

  const response = await post(undefined, TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
  expect(response.status).toBe(500);
  await expect(response.text()).resolves.toBe("Internal Server Error");
});

it.each([
  ["shared-secret scope spoofing", false, TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS],
  ["trusted-proxy requester without admin", true, "", REQUESTER_WRITE_HEADERS],
] as const)("rejects %s", async (_name, trustedProxy, token, headers) => {
  if (trustedProxy) {
    allowTrustedProxyAuth();
  }
  const response = await post(undefined, token, headers);
  await expectError(response, 403, "forbidden", "missing scope: operator.admin");
  expect(loadSessionEntryMock).not.toHaveBeenCalled();
  expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
});
