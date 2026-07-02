import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../context-engine/types.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleContextEngineControlHttpRequest } from "./context-engine-control-http.js";

const testState = vi.hoisted(() => ({
  cfg: {
    agents: {
      list: [{ id: "openmanager-u-a", default: true }],
    },
  },
  auth: { mode: "none" } as ResolvedGatewayAuth,
  engine: undefined as ContextEngine | undefined,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => testState.cfg,
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(async () => {
    if (!testState.engine) {
      throw new Error("no engine");
    }
    return testState.engine;
  }),
}));

let server: ReturnType<typeof createServer> | undefined;
let port = 0;

beforeAll(async () => {
  const nextServer = createServer((req, res) => {
    void handleContextEngineControlHttpRequest(req, res, {
      auth: testState.auth,
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });
  server = nextServer;

  await new Promise<void>((resolve, reject) => {
    nextServer.once("error", reject);
    nextServer.listen(0, "127.0.0.1", () => {
      const address = nextServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("context-engine control test server did not bind to TCP address"));
        return;
      }
      port = address.port;
      resolve();
    });
  });
});

afterAll(async () => {
  const currentServer = server;
  if (!currentServer) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    currentServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  testState.auth = { mode: "none" } as ResolvedGatewayAuth;
  testState.engine = {
    info: { id: "lossless-claw", name: "Lossless Claw" },
    ingest: vi.fn(),
    assemble: vi.fn(),
    compact: vi.fn(),
    getControlCapabilities: vi.fn(async () => ({
      status: true,
      doctor: true,
      rotate: true,
    })),
    control: vi.fn(async (input: { operation?: string }) => {
      if (input.operation === "doctor") {
        return { operation: "doctor", ok: true, warnings: [] };
      }
      if (input.operation === "rotate") {
        return {
          operation: "rotate",
          messageCount: 2,
          lastRotatedAt: "2026-07-02T00:00:00.000Z",
        };
      }
      return {
        operation: "status",
        active: true,
        messageCount: 3,
      };
    }),
  } as unknown as ContextEngine;
});

function url(path: string) {
  return `http://127.0.0.1:${port}${path}`;
}

const READ_HEADERS = { "x-openclaw-scopes": "operator.read" };
const WRITE_HEADERS = { "x-openclaw-scopes": "operator.write" };
const ADMIN_HEADERS = { "x-openclaw-scopes": "operator.admin" };

async function postControl(body: unknown, headers: Record<string, string>) {
  return fetch(url("/v1/context-engine/control"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("context engine control HTTP", () => {
  it("rejects invalid bearer auth before dispatch", async () => {
    testState.auth = { mode: "token", token: "secret", allowTailscale: false };
    const res = await fetch(url("/v1/context-engine/capabilities?agentId=openmanager-u-a"), {
      headers: { Authorization: "Bearer wrong" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { type: "unauthorized" },
    });
  });

  it("serves capabilities and control with valid bearer auth", async () => {
    testState.auth = { mode: "token", token: "secret", allowTailscale: false };
    const capabilities = await fetch(
      url("/v1/context-engine/capabilities?agentId=openmanager-u-a"),
      {
        headers: { Authorization: "Bearer secret" },
      },
    );
    const control = await fetch(url("/v1/context-engine/control"), {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: "openmanager-u-a",
        operation: "status",
        sessionKey: "user:u1:chat",
      }),
    });

    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({
      ok: true,
      result: { capabilities: { status: true, doctor: true, rotate: true } },
    });
    expect(control.status).toBe(200);
    expect(await control.json()).toMatchObject({
      ok: true,
      result: { operation: "status", active: true, messageCount: 3 },
    });
  });

  it("allows read-scoped callers to inspect capabilities, status, and doctor", async () => {
    const capabilities = await fetch(
      url("/v1/context-engine/capabilities?agentId=openmanager-u-a"),
      { headers: READ_HEADERS },
    );
    const status = await postControl(
      {
        agentId: "openmanager-u-a",
        operation: "status",
        sessionKey: "user:u1:chat",
      },
      READ_HEADERS,
    );
    const doctor = await postControl(
      {
        agentId: "openmanager-u-a",
        operation: "doctor",
        sessionKey: "user:u1:chat",
      },
      READ_HEADERS,
    );

    expect(capabilities.status).toBe(200);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      ok: true,
      result: { operation: "status", active: true, messageCount: 3 },
    });
    expect(doctor.status).toBe(200);
    expect(await doctor.json()).toEqual({
      ok: true,
      result: { operation: "doctor", ok: true, warnings: [] },
    });
  });

  it("requires admin scope for rotate", async () => {
    const writeRotate = await postControl(
      {
        agentId: "openmanager-u-a",
        operation: "rotate",
        sessionKey: "user:u1:chat",
      },
      WRITE_HEADERS,
    );
    const adminRotate = await postControl(
      {
        agentId: "openmanager-u-a",
        operation: "rotate",
        sessionKey: "user:u1:chat-2",
      },
      ADMIN_HEADERS,
    );

    expect(writeRotate.status).toBe(403);
    expect(await writeRotate.json()).toEqual({
      ok: false,
      error: {
        type: "forbidden",
        message: "missing scope: operator.admin",
      },
    });
    expect(adminRotate.status).toBe(200);
    expect(await adminRotate.json()).toEqual({
      ok: true,
      result: {
        operation: "rotate",
        messageCount: 2,
        lastRotatedAt: "2026-07-02T00:00:00.000Z",
      },
    });
  });
});
