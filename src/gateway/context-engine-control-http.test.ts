import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../context-engine/types.js";
import { handleContextEngineControlHttpRequest } from "./context-engine-control-http.js";

const testState = vi.hoisted(() => ({
  cfg: {
    agents: {
      list: [{ id: "openmanager-u-a", default: true }],
    },
  },
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
  server = createServer((req, res) => {
    void handleContextEngineControlHttpRequest(req, res, {
      auth: { mode: "token", token: "secret", allowTailscale: false },
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
      port = (server?.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
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
    control: vi.fn(async () => ({
      operation: "status",
      active: true,
      messageCount: 3,
    })),
  } as unknown as ContextEngine;
});

function url(path: string) {
  return `http://127.0.0.1:${port}${path}`;
}

describe("context engine control HTTP", () => {
  it("rejects invalid bearer auth before dispatch", async () => {
    const res = await fetch(url("/v1/context-engine/capabilities?agentId=openmanager-u-a"), {
      headers: { Authorization: "Bearer wrong" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { type: "unauthorized" },
    });
  });

  it("serves capabilities and control with valid bearer auth", async () => {
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
});
