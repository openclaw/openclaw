/**
 * Same-session agent hook dispatches must be serialized, not raced.
 *
 * Concurrent runs for one sessionKey race on the cron session-lifecycle claim;
 * the losers throw CronSessionLifecycleClaimError and their payloads are
 * silently dropped (openclaw/openclaw#110109). These tests pin the queueing
 * behavior in dispatchAgentHook that prevents the race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatMock = vi.fn();
const runCronIsolatedAgentTurnMock = vi.fn();
const resolveMainSessionKeyMock = vi.fn(() => "main-session");
const loadConfigMock = vi.fn(() => ({}));
const logHooksInfoMock = vi.fn();
const logHooksWarnMock = vi.fn();

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));
vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: resolveMainSessionKeyMock,
  resolveMainSessionKey: vi.fn(
    (cfg?: { session?: { mainKey?: string } }) => `agent:main:${cfg?.session?.mainKey ?? "main"}`,
  ),
  resolveAgentMainSessionKey: vi.fn(
    (params: { cfg?: { session?: { mainKey?: string } }; agentId: string }) =>
      `agent:${params.agentId}:${params.cfg?.session?.mainKey ?? "main"}`,
  ),
}));
vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

let capturedDispatchAgentHook: ((...args: unknown[]) => unknown) | undefined;

vi.mock("./hooks-request-handler.js", () => ({
  createHooksRequestHandler: vi.fn((opts: Record<string, unknown>) => {
    capturedDispatchAgentHook = opts.dispatchAgentHook as typeof capturedDispatchAgentHook;
    return vi.fn();
  }),
}));

const { createGatewayHooksRequestHandler } = await import("./hooks.js");

function buildMinimalParams() {
  return {
    deps: {} as never,
    getHooksConfig: () => null,
    getClientIpConfig: () => ({
      trustedProxies: undefined,
      allowRealIpFallback: false,
    }),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: logHooksWarnMock,
      debug: vi.fn(),
      info: logHooksInfoMock,
      error: vi.fn(),
    } as never,
  };
}

function buildAgentPayload(name: string, sessionKey: string, message = "test message") {
  return {
    message,
    name,
    agentId: undefined,
    idempotencyKey: undefined,
    wakeMode: "now" as const,
    sessionKey,
    sourcePath: "/hooks/agent",
    deliver: false,
    channel: "last" as const,
    to: undefined,
    model: undefined,
    thinking: undefined,
    timeoutSeconds: undefined,
    allowUnsafeExternalContent: undefined,
    externalContentSource: undefined,
  };
}

function dispatchAgentHook(payload: unknown): unknown {
  if (!capturedDispatchAgentHook) {
    throw new Error("dispatchAgentHook missing");
  }
  return capturedDispatchAgentHook(payload);
}

/** A runCronIsolatedAgentTurn stand-in that blocks until released. */
function deferredRun() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async (params: { message: string }) => {
    await gate;
    return {
      status: "ok",
      summary: `done:${params.message}`,
      delivered: false,
    };
  });
  return { run, release };
}

describe("dispatchAgentHook same-session serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler(buildMinimalParams());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queues a same-session burst so the second wake is never dropped", async () => {
    const first = deferredRun();
    const second = deferredRun();
    runCronIsolatedAgentTurnMock
      .mockImplementationOnce(first.run)
      .mockImplementationOnce(second.run);

    dispatchAgentHook(buildAgentPayload("Review", "pr:12077", "review submitted"));
    dispatchAgentHook(buildAgentPayload("Comment", "pr:12077", "inline comment"));

    // Only the first run starts; the second waits instead of racing the claim.
    await vi.waitFor(() => expect(first.run).toHaveBeenCalledTimes(1));
    expect(second.run).not.toHaveBeenCalled();
    expect(logHooksInfoMock).toHaveBeenCalledWith(
      "hook agent run queued behind in-flight same-session run",
      { sessionKey: "pr:12077" },
    );

    first.release();
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));
    expect(second.run.mock.calls[0][0].message).toBe("inline comment");

    second.release();
    await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
  });

  it("processes a same-session burst strictly in arrival order", async () => {
    const started: string[] = [];
    runCronIsolatedAgentTurnMock.mockImplementation(async (params: { message: string }) => {
      started.push(params.message);
      await Promise.resolve();
      return { status: "ok", summary: "done", delivered: false };
    });

    dispatchAgentHook(buildAgentPayload("A", "pr:1", "first"));
    dispatchAgentHook(buildAgentPayload("B", "pr:1", "second"));
    dispatchAgentHook(buildAgentPayload("C", "pr:1", "third"));

    await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(3));
    expect(started).toEqual(["first", "second", "third"]);
  });

  it("does not serialize hooks targeting different session keys", async () => {
    const first = deferredRun();
    const second = deferredRun();
    runCronIsolatedAgentTurnMock
      .mockImplementationOnce(first.run)
      .mockImplementationOnce(second.run);

    dispatchAgentHook(buildAgentPayload("A", "pr:1"));
    dispatchAgentHook(buildAgentPayload("B", "pr:2"));

    // Both start without either finishing — cross-session concurrency intact.
    await vi.waitFor(() => expect(first.run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));

    first.release();
    second.release();
    await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
  });

  it("keeps draining the session queue after a run fails", async () => {
    runCronIsolatedAgentTurnMock
      .mockRejectedValueOnce(new Error('Session "pr:1" changed while starting work. Retry.'))
      .mockResolvedValueOnce({
        status: "ok",
        summary: "done",
        delivered: false,
      });

    dispatchAgentHook(buildAgentPayload("A", "pr:1", "loser"));
    dispatchAgentHook(buildAgentPayload("B", "pr:1", "survivor"));

    await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
    expect(runCronIsolatedAgentTurnMock.mock.calls[1][0].message).toBe("survivor");
  });
});
