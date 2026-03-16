import { describe, expect, it, vi } from "vitest";
import { chatHandlers } from "./chat.js";

function createActiveRun(sessionKey: string, owner?: { connId?: string; deviceId?: string }) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: `${sessionKey}-session`,
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    ownerConnId: owner?.connId,
    ownerDeviceId: owner?.deviceId,
  };
}

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map<string, number>(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...overrides,
  };
}

async function invokeChatAbort(params: {
  context: ReturnType<typeof createContext>;
  request: { sessionKey: string; runId?: string };
  client?: {
    connId?: string;
    connect?: {
      device?: { id?: string };
      scopes?: string[];
    };
  } | null;
}) {
  const respond = vi.fn();
  await chatHandlers["chat.abort"]({
    params: params.request,
    respond: respond as never,
    context: params.context as never,
    req: {} as never,
    client: (params.client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("chat.abort authorization", () => {
  it("rejects explicit run aborts from other clients", async () => {
    const context = createContext({
      chatAbortControllers: new Map([
        ["run-1", createActiveRun("main", { connId: "conn-owner", deviceId: "dev-owner" })],
      ]),
    });

    const respond = await invokeChatAbort({
      context,
      request: { sessionKey: "main", runId: "run-1" },
      client: {
        connId: "conn-other",
        connect: { device: { id: "dev-other" }, scopes: ["operator.write"] },
      },
    });

    const [ok, payload, error] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "unauthorized" });
    expect(context.chatAbortControllers.has("run-1")).toBe(true);
  });

  it("allows the same paired device to abort after reconnecting", async () => {
    const context = createContext({
      chatAbortControllers: new Map([
        ["run-1", createActiveRun("main", { connId: "conn-old", deviceId: "dev-1" })],
      ]),
    });

    const respond = await invokeChatAbort({
      context,
      request: { sessionKey: "main", runId: "run-1" },
      client: {
        connId: "conn-new",
        connect: { device: { id: "dev-1" }, scopes: ["operator.write"] },
      },
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-1"] });
    expect(context.chatAbortControllers.has("run-1")).toBe(false);
  });

  it("only aborts session-scoped runs owned by the requester", async () => {
    const context = createContext({
      chatAbortControllers: new Map([
        ["run-mine", createActiveRun("main", { deviceId: "dev-1" })],
        ["run-other", createActiveRun("main", { deviceId: "dev-2" })],
      ]),
    });

    const respond = await invokeChatAbort({
      context,
      request: { sessionKey: "main" },
      client: {
        connId: "conn-1",
        connect: { device: { id: "dev-1" }, scopes: ["operator.write"] },
      },
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-mine"] });
    expect(context.chatAbortControllers.has("run-mine")).toBe(false);
    expect(context.chatAbortControllers.has("run-other")).toBe(true);
  });

  it("allows operator.admin clients to bypass owner checks", async () => {
    const context = createContext({
      chatAbortControllers: new Map([
        ["run-1", createActiveRun("main", { connId: "conn-owner", deviceId: "dev-owner" })],
      ]),
    });

    const respond = await invokeChatAbort({
      context,
      request: { sessionKey: "main", runId: "run-1" },
      client: {
        connId: "conn-admin",
        connect: { device: { id: "dev-admin" }, scopes: ["operator.admin"] },
      },
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-1"] });
  });
});
