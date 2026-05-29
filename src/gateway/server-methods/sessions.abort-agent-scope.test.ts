import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const resolveSessionKeyForRunMock = vi.fn();
const loadSessionStoreMock = vi.fn().mockReturnValue({});
const updateSessionStoreMock = vi.fn();

vi.mock("../server-session-key.js", () => ({
  resolveSessionKeyForRun: (...args: unknown[]) => resolveSessionKeyForRunMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.abort": (...args: unknown[]) => chatAbortMock(...args),
  },
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>("../../config/sessions.js");
  return {
    ...actual,
    loadSessionStore: (...args: unknown[]) => loadSessionStoreMock(...args),
    updateSessionStore: (...args: unknown[]) => updateSessionStoreMock(...args),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (sessionKey: string) => ({ canonicalKey: sessionKey }),
    resolveGatewaySessionStoreTarget: ({ key }: { key: string }) => ({
      storePath: `/tmp/test-store-${key}.json`,
      storeKeys: [key],
    }),
  };
});

import { sessionsHandlers } from "./sessions.js";

function createActiveRun(sessionKey: string) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-active",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    kind: "chat-send" as const,
  };
}

describe("sessions.abort agent scope", () => {
  beforeEach(() => {
    chatAbortMock.mockReset();
    resolveSessionKeyForRunMock.mockReset();
    loadSessionStoreMock.mockReset().mockReturnValue({});
    updateSessionStoreMock.mockReset();
  });

  it("does not abort an active run whose session key belongs to another requested agent", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = {
      chatAbortControllers: new Map([["run-beta", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "beta" }] },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-1" } as never,
      params: { runId: "run-beta", agentId: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).toHaveBeenCalledWith("run-beta", { agentId: "main" });
    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(activeRun.controller.signal.aborted).toBe(false);
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: null,
      status: "no-active-run",
    });
  });

  it("preserves runId-only aborts for active non-default agent runs", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = {
      chatAbortControllers: new Map([["run-beta", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "beta" }] },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-2" } as never,
      params: { runId: "run-beta" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "agent:beta:dashboard:target", runId: "run-beta" },
      }),
    );
  });

  it("aborts global-scope active runs for non-default agents", async () => {
    const activeRun = createActiveRun("global");
    const context = {
      chatAbortControllers: new Map([["run-global", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-global" } as never,
      params: { runId: "run-global", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "global", runId: "run-global" },
      }),
    );
  });

  it("aborts an active legacy-key run owned by the configured default agent", async () => {
    const activeRun = createActiveRun("main");
    const context = {
      chatAbortControllers: new Map([["run-work", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "work", default: true }] },
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-3" } as never,
      params: { runId: "run-work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "main", runId: "run-work" },
      }),
    );
  });

  it("rejects key-based aborts when key agent does not match agentId", async () => {
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "beta" }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-4" } as never,
      params: { key: "agent:beta:main", agentId: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "session key agent does not match agentId",
      }),
    );
  });

  it("applies agentId to legacy key-based abort aliases", async () => {
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-5" } as never,
      params: { key: "main", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "agent:work:main", runId: undefined },
      }),
    );
  });

  it("does not use a raw legacy key alias that belongs to another agent", async () => {
    const activeRun = createActiveRun("main");
    const context = {
      chatAbortControllers: new Map([["run-work", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-6" } as never,
      params: { key: "main", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "agent:work:main", runId: undefined },
      }),
    );
  });

  it("keeps the raw legacy key alias when it belongs to the requested agent", async () => {
    const activeRun = createActiveRun("main");
    const context = {
      chatAbortControllers: new Map([["run-work", activeRun]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "work", default: true }, { id: "main" }] },
      }),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-7" } as never,
      params: { key: "main", agentId: "work" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatAbortMock).toHaveBeenCalledTimes(1);
    expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        params: { sessionKey: "main", runId: undefined },
      }),
    );
  });

  it("heals a stale running session entry when abort finds no active run", async () => {
    const frozenAt = Date.now();
    chatAbortMock.mockImplementation(async ({ respond: abortRespond }: { respond: (...args: unknown[]) => void }) => {
      abortRespond(true, { runIds: [] });
    });
    const staleRow = { sessionId: "sess-stuck", status: "running", updatedAt: frozenAt, abortedLastRun: false };
    loadSessionStoreMock.mockReturnValue({
      main: staleRow,
    });
    // Mock updateSessionStore to execute the callback so we can verify mutations
    updateSessionStoreMock.mockImplementation(async (_path: string, updater: (s: Record<string, unknown>) => void) => {
      const mockStore: Record<string, Record<string, unknown>> = {
        main: { ...staleRow },
      };
      updater(mockStore);
      // Verify the callback actually clears the stale state
      expect(mockStore.main.status).toBeUndefined();
      expect(mockStore.main.abortedLastRun).toBe(false);
    });
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }] },
      }),
      dedupe: new Map(),
      getSessionEventSubscriberConnIds: () => new Set(),
      broadcastToConnIds: () => {},
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-heal" } as never,
      params: { key: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, status: "no-active-run" }),
      undefined,
      undefined,
    );
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
  });

  it("does not clear a row that was updated after the snapshot (race guard)", async () => {
    const originalTime = Date.now();
    chatAbortMock.mockImplementation(async ({ respond: abortRespond }: { respond: (...args: unknown[]) => void }) => {
      abortRespond(true, { runIds: [] });
    });
    loadSessionStoreMock.mockReturnValue({
      main: { sessionId: "sess-race", status: "running", updatedAt: originalTime, abortedLastRun: false },
    });
    // Simulate the row being updated (new run started) between snapshot and callback
    updateSessionStoreMock.mockImplementation(async (_path: string, updater: (s: Record<string, unknown>) => void) => {
      const mockStore: Record<string, Record<string, unknown>> = {
        main: { sessionId: "sess-race", status: "running", updatedAt: originalTime + 5000, abortedLastRun: false },
      };
      updater(mockStore);
      // Row should NOT be cleared because updatedAt changed
      expect(mockStore.main.status).toBe("running");
    });
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }] },
      }),
      dedupe: new Map(),
      getSessionEventSubscriberConnIds: () => new Set(),
      broadcastToConnIds: () => {},
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-race" } as never,
      params: { key: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
  });

  it("does not heal session entry when status is not running", async () => {
    chatAbortMock.mockImplementation(async ({ respond: abortRespond }: { respond: (...args: unknown[]) => void }) => {
      abortRespond(true, { runIds: [] });
    });
    loadSessionStoreMock.mockReturnValue({
      main: { sessionId: "sess-idle", status: undefined, updatedAt: Date.now() },
    });
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }] },
      }),
      dedupe: new Map(),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-noop" } as never,
      params: { key: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("heals a stale running row stored under a raw legacy alias key", async () => {
    const frozenAt = Date.now();
    chatAbortMock.mockImplementation(async ({ respond: abortRespond }: { respond: (...args: unknown[]) => void }) => {
      abortRespond(true, { runIds: [] });
    });
    // Row is stored under raw "main" (legacy alias), not "agent:main:main"
    const staleRow = { sessionId: "sess-legacy", status: "running", updatedAt: frozenAt, abortedLastRun: false };
    loadSessionStoreMock.mockReturnValue({
      main: staleRow,
    });
    updateSessionStoreMock.mockImplementation(async (_path: string, updater: (s: Record<string, unknown>) => void) => {
      const mockStore: Record<string, Record<string, unknown>> = {
        main: { ...staleRow },
      };
      updater(mockStore);
      expect(mockStore.main.status).toBeUndefined();
    });
    const context = {
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }] },
      }),
      dedupe: new Map(),
      getSessionEventSubscriberConnIds: () => new Set(),
      broadcastToConnIds: () => {},
    } as unknown as GatewayRequestContext;
    const respond = vi.fn() as unknown as RespondFn;

    // Request with raw key "main" (not scoped)
    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-legacy" } as never,
      params: { key: "main" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, status: "no-active-run" }),
      undefined,
      undefined,
    );
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
  });
});
