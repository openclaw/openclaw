import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  diagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import type { GatewayAuthResult } from "./auth.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";

let cfg: Record<string, unknown> = {};
const mocks = vi.hoisted(() => ({
  authMock: vi.fn(async (): Promise<GatewayAuthResult> => ({ ok: true })),
  isLocalDirectRequestMock: vi.fn(() => false),
  loadSessionEntryMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  killSubagentRunAdminMock: vi.fn(),
}));
const authMock = mocks.authMock;
const isLocalDirectRequestMock = mocks.isLocalDirectRequestMock;
const loadSessionEntryMock = mocks.loadSessionEntryMock;
const updateSessionStoreMock = mocks.updateSessionStoreMock;
const killSubagentRunAdminMock = mocks.killSubagentRunAdminMock;

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: mocks.authMock,
  isLocalDirectRequest: mocks.isLocalDirectRequestMock,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntryMock,
}));

vi.mock("../config/sessions.js", async () => {
  const original =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...original,
    updateSessionStore: mocks.updateSessionStoreMock,
  };
});

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: mocks.killSubagentRunAdminMock,
}));

const { handleSessionAbortHttpRequest } = await import("./sessions-abort-http.js");

beforeEach(() => {
  cfg = {};
  authMock.mockReset();
  authMock.mockResolvedValue({ ok: true, method: "trusted-proxy" });
  isLocalDirectRequestMock.mockReset();
  isLocalDirectRequestMock.mockReturnValue(false);
  loadSessionEntryMock.mockReset();
  updateSessionStoreMock.mockReset();
  killSubagentRunAdminMock.mockReset();
  killSubagentRunAdminMock.mockResolvedValue({ found: false, killed: false });
  resetDiagnosticEventsForTest();
  resetDiagnosticSessionStateForTest();
});

function createJsonRequest(
  pathname: string,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
) {
  const rawBody = JSON.stringify(body);
  const req = Readable.from([rawBody]) as unknown as IncomingMessage;
  req.method = "POST";
  req.url = pathname;
  req.headers = {
    authorization: `Bearer ${TEST_GATEWAY_TOKEN}`,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(rawBody)),
    "x-openclaw-scopes": "operator.admin",
    ...extraHeaders,
  };
  return req;
}

function createJsonResponse() {
  let body = "";
  const res = {
    statusCode: 200,
    setHeader() {
      return this;
    },
    end(value?: unknown) {
      body =
        typeof value === "string"
          ? value
          : Buffer.isBuffer(value)
            ? value.toString("utf-8")
            : value == null
              ? ""
              : JSON.stringify(value);
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get statusCode() {
      return res.statusCode;
    },
    json(): unknown {
      return body ? JSON.parse(body) : undefined;
    },
  };
}

async function post(
  pathname: string,
  body: Record<string, unknown> = {},
  extraHeaders?: Record<string, string>,
) {
  const req = createJsonRequest(pathname, body, extraHeaders);
  const response = createJsonResponse();
  const handled = await handleSessionAbortHttpRequest(req, response.res, {
    auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
  });
  return { handled, response };
}

describe("POST /api/sessions/:sessionKey/abort", () => {
  it("removes an in-memory session, emits an admin abort event, and marks the store failed", async () => {
    const sessionKey = "agent:main:subagent:worker";
    const entry: SessionEntry = {
      sessionId: "sess-worker",
      updatedAt: 100,
      status: "running",
    };
    const store: Record<string, SessionEntry> = { [sessionKey]: entry };
    loadSessionEntryMock.mockReturnValue({
      cfg,
      storePath: "/tmp/sessions.json",
      entry,
      canonicalKey: sessionKey,
    });
    updateSessionStoreMock.mockImplementation(
      async (_storePath: string, mutator: (store: Record<string, SessionEntry>) => void) => {
        mutator(store);
      },
    );
    diagnosticSessionStates.set(sessionKey, {
      sessionId: "sess-worker",
      sessionKey,
      lastActivity: 123,
      state: "processing",
      queueDepth: 1,
    });
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    const { handled, response } = await post(
      `/api/sessions/${encodeURIComponent(sessionKey)}/abort`,
      { reason: "incident cleanup" },
    );
    stop();

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      aborted: true,
      previousStatus: "running",
      wasInMemory: true,
    });
    expect(diagnosticSessionStates.has(sessionKey)).toBe(false);
    expect(store[sessionKey]).toMatchObject({
      status: "failed",
      abortedBy: "admin_cli",
      abortReason: "incident cleanup",
    });
    expect(store[sessionKey]?.endedAt).toEqual(expect.any(Number));
    expect(events).toEqual([
      expect.objectContaining({
        type: "session.aborted_by_admin",
        sessionKey,
        sessionId: "sess-worker",
        previousStatus: "running",
        wasInMemory: true,
        reason: "incident cleanup",
      }),
    ]);
  });

  it("returns 404 for an unknown session key", async () => {
    loadSessionEntryMock.mockReturnValue({
      cfg,
      entry: undefined,
      canonicalKey: "agent:main:missing",
    });

    const { handled, response } = await post("/api/sessions/agent%3Amain%3Amissing/abort");

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { type: "not_found" },
    });
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("allows loopback admin aborts even when bearer auth cannot assert scope headers", async () => {
    isLocalDirectRequestMock.mockReturnValue(true);
    authMock.mockResolvedValue({ ok: true, method: "token" });
    const sessionKey = "agent:main:subagent:local";
    loadSessionEntryMock.mockReturnValue({
      cfg,
      entry: undefined,
      canonicalKey: sessionKey,
    });
    diagnosticSessionStates.set(sessionKey, {
      sessionId: "sess-local",
      sessionKey,
      lastActivity: 123,
      state: "processing",
      queueDepth: 1,
    });

    const { response } = await post(
      `/api/sessions/${encodeURIComponent(sessionKey)}/abort`,
      {},
      { "x-openclaw-scopes": "" },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      aborted: true,
      previousStatus: "processing",
      wasInMemory: true,
    });
  });
});
