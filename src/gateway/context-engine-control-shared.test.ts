import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../context-engine/types.js";
import {
  getContextEngineControlCapabilities,
  invokeContextEngineControl,
  resetContextEngineControlRateLimitsForTest,
} from "./context-engine-control-shared.js";

const engineState = vi.hoisted(() => ({
  engine: undefined as ContextEngine | undefined,
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(async () => {
    if (!engineState.engine) {
      throw new Error("no engine");
    }
    return engineState.engine;
  }),
}));

const cfg = {
  agents: {
    list: [{ id: "openmanager-u-a", default: true }, { id: "other" }],
  },
} as never;

function installEngine(overrides: Partial<ContextEngine> = {}) {
  const control = vi.fn(async (params: { operation: string }) => {
    if (params.operation === "status") {
      return {
        operation: "status",
        active: true,
        messageCount: 12,
        lastRotatedAt: null,
        rawDebug: "/tmp/secret",
      };
    }
    if (params.operation === "doctor") {
      return {
        operation: "doctor",
        ok: false,
        warnings: ["context drift detected"],
        dbPath: "/tmp/secret.db",
      };
    }
    return {
      operation: "rotate",
      messageCount: 12,
      lastRotatedAt: "2026-06-30T00:00:00.000Z",
      backupPath: "/tmp/secret.bak",
    };
  });
  engineState.engine = {
    info: { id: "lossless-claw", name: "Lossless Claw" },
    ingest: vi.fn(),
    assemble: vi.fn(),
    compact: vi.fn(),
    getControlCapabilities: vi.fn(async () => ({
      status: true,
      doctor: true,
      rotate: true,
    })),
    control,
    ...overrides,
  } as unknown as ContextEngine;
  return { control };
}

beforeEach(() => {
  resetContextEngineControlRateLimitsForTest();
  engineState.engine = undefined;
});

describe("context engine control dispatcher", () => {
  it("discovers sanitized control capabilities for a known agent", async () => {
    installEngine();

    const outcome = await getContextEngineControlCapabilities({
      cfg,
      agentId: "openmanager-u-a",
    });

    expect(outcome).toMatchObject({
      ok: true,
      status: 200,
      result: {
        agentId: "openmanager-u-a",
        engineId: "lossless-claw",
        capabilities: { status: true, doctor: true, rotate: true },
      },
    });
  });

  it("invokes status with an opaque product session key", async () => {
    const { control } = installEngine();

    const outcome = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "openmanager-u-a",
        operation: "status",
        sessionKey: "user:4d85e68f:chat",
      },
    });

    expect(outcome).toEqual({
      ok: true,
      status: 200,
      result: {
        operation: "status",
        active: true,
        messageCount: 12,
        lastRotatedAt: null,
      },
    });
    expect(control).toHaveBeenCalledWith({
      agentId: "openmanager-u-a",
      operation: "status",
      sessionKey: "user:4d85e68f:chat",
    });
  });

  it("rejects malformed operation and unknown agent before dispatch", async () => {
    const { control } = installEngine();

    const badOperation = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "openmanager-u-a",
        operation: "drop",
        sessionKey: "user:u1:chat",
      },
    });
    const unknownAgent = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "missing",
        operation: "status",
        sessionKey: "user:u1:chat",
      },
    });

    expect(badOperation).toMatchObject({
      ok: false,
      status: 400,
      error: { type: "invalid_request" },
    });
    expect(unknownAgent).toMatchObject({
      ok: false,
      status: 404,
      error: { type: "not_found" },
    });
    expect(control).not.toHaveBeenCalled();
  });

  it("rejects cross-agent reserved session keys", async () => {
    const { control } = installEngine();

    const outcome = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "openmanager-u-a",
        operation: "status",
        sessionKey: "agent:other:main",
      },
    });

    expect(outcome).toMatchObject({
      ok: false,
      status: 403,
      error: { type: "forbidden" },
    });
    expect(control).not.toHaveBeenCalled();
  });

  it("returns capability unavailable when the selected engine does not support an operation", async () => {
    const { control } = installEngine({
      getControlCapabilities: vi.fn(async () => ({
        status: true,
        doctor: true,
        rotate: false,
      })),
    });

    const outcome = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "openmanager-u-a",
        operation: "rotate",
        sessionKey: "user:u1:chat",
      },
    });

    expect(outcome).toMatchObject({
      ok: false,
      status: 501,
      error: { type: "capability_unavailable" },
    });
    expect(control).not.toHaveBeenCalled();
  });

  it("rate-limits repeated rotate for the same agent session", async () => {
    installEngine();

    const first = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "openmanager-u-a",
        operation: "rotate",
        sessionKey: "user:u1:chat",
      },
      now: 1000,
      rotateRateLimitMs: 5000,
    });
    const second = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "openmanager-u-a",
        operation: "rotate",
        sessionKey: "user:u1:chat",
      },
      now: 2000,
      rotateRateLimitMs: 5000,
    });

    expect(first).toMatchObject({ ok: true, status: 200 });
    expect(second).toMatchObject({
      ok: false,
      status: 429,
      error: { type: "rate_limited" },
    });
  });

  it("sanitizes rotate result fields and failure text", async () => {
    installEngine();
    const rotated = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "openmanager-u-a",
        operation: "rotate",
        sessionKey: "user:u1:chat",
      },
      now: 1000,
    });

    installEngine({
      control: vi.fn(async () => {
        const err = new Error("C:\\secret\\gateway-token");
        err.name = "LcmProgrammaticControlUnavailableError";
        throw err;
      }),
    });
    const failed = await invokeContextEngineControl({
      cfg,
      input: {
        agentId: "openmanager-u-a",
        operation: "status",
        sessionKey: "user:u1:chat",
      },
      now: 70000,
    });

    expect(JSON.stringify(rotated)).not.toContain("secret.bak");
    expect(JSON.stringify(rotated)).not.toContain("/tmp");
    expect(failed).toMatchObject({
      ok: false,
      status: 503,
      error: { type: "unavailable" },
    });
    expect(JSON.stringify(failed)).not.toContain("gateway-token");
    expect(JSON.stringify(failed)).not.toContain("C:\\secret");
  });
});
