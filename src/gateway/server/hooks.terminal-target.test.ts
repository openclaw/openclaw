import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeferredHookWake } from "../../cron/service/wake.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";

let terminalObserved = createDeferred();
let warningObserved = createDeferred();
const deferHookWakeMock = vi.fn<DeferredHookWake>();
const captureSessionEventTargetMock = vi.fn(async (agentId: string, sessionKey: string) => ({
  agentId,
  sessionKey,
  sessionId: "captured-session",
  generation: "captured-generation",
}));
const enqueueSessionEventMock = vi.fn((_text: string, _options: Record<string, unknown>) => {
  terminalObserved.resolve();
  return {
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve({ status: "completed" }),
  };
});
const runCronIsolatedAgentTurnMock = vi.fn();
const loadConfigMock = vi.fn<() => OpenClawConfig>();
const logHooksWarnMock = vi.fn((message: string) => {
  if (
    message === "hook terminal event not delivered" ||
    message === "hook agent terminal event suppressed"
  ) {
    warningObserved.resolve();
  }
});

// mock-isolation: Observe the terminal destination without admitting an ordinary reply turn.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: captureSessionEventTargetMock,
  enqueueSessionEventForHost: enqueueSessionEventMock,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));
vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

let capturedDispatchAgentHook: ((value: HookPayload) => Promise<unknown>) | undefined;

vi.mock("./hooks-request-handler.js", () => ({
  createHooksRequestHandler: vi.fn((opts: Record<string, unknown>) => {
    capturedDispatchAgentHook = opts.dispatchAgentHook as typeof capturedDispatchAgentHook;
    return vi.fn();
  }),
}));

const { createGatewayHooksRequestHandler } = await import("./hooks.js");

type HookPayload = {
  message: string;
  name: string;
  agentId?: string;
  effectiveAgentId: string;
  wakeMode: "now" | "next-heartbeat";
  sessionKey: string;
  sourcePath: string;
  deliver: boolean;
  channel: "last";
  delivery: { mode: "none" };
};

function payload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    message: "test message",
    name: "Email",
    effectiveAgentId: "main",
    wakeMode: "now",
    sessionKey: "session-1",
    sourcePath: "/hooks/agent",
    deliver: true,
    channel: "last",
    delivery: { mode: "none" },
    ...overrides,
  };
}

function globalConfig(systemAgentId: "main" | "work", includeMain = true): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: systemAgentId } },
      entries: {
        ...(includeMain ? { main: {} } : {}),
        work: {},
      },
    },
    session: { scope: "global" },
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function dispatch(value: HookPayload): Promise<unknown> {
  if (!capturedDispatchAgentHook) {
    throw new Error("dispatchAgentHook missing");
  }
  return capturedDispatchAgentHook(value);
}

function expectOwnedEvent(text: string, agentId: string): void {
  const call = enqueueSessionEventMock.mock.calls.find(([actual]) => actual === text);
  expect(call?.[1]).toMatchObject({
    agentId,
    sessionKey: "global",
    expectedTarget: { agentId, sessionKey: "global", sessionId: "captured-session" },
  });
}

async function startGatedRun(
  result: "success" | "failure",
  wakeMode: "now" | "next-heartbeat" = "now",
) {
  const gate = createDeferred();
  const started = createDeferred();
  runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
    if (result === "failure") {
      throw new Error("agent exploded");
    }
    return { status: "ok", summary: "done", delivered: false, deliveryAttempted: false };
  });
  void dispatch(payload({ wakeMode }));
  await started.promise;
  return gate;
}

describe("global hook terminal target resolution", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    terminalObserved = createDeferred();
    deferHookWakeMock.mockImplementation(async ({ commitGuard }) => {
      commitGuard();
      terminalObserved.resolve();
      return { ok: true, eventOutcome: "queued" };
    });
    warningObserved = createDeferred();
    loadConfigMock.mockReturnValue(globalConfig("main"));
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler({
      scheduler: createTestGatewayScheduler("fake-timers"),
      deps: {} as never,
      deferHookWake: deferHookWakeMock,
      getHooksConfig: () => null,
      getClientIpConfig: () => ({ trustedProxies: undefined, allowRealIpFallback: false }),
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks: {
        warn: logHooksWarnMock,
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      } as never,
    });
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it.each(["now", "next-heartbeat"] as const)(
    "keeps the accepted %s target when hooks are disabled and the system agent changes",
    async (wakeMode) => {
      const gate = await startGatedRun("success", wakeMode);
      loadConfigMock.mockReturnValue({
        ...globalConfig("work"),
        hooks: { enabled: false },
      });
      gate.resolve();

      await terminalObserved.promise;
      if (wakeMode === "now") {
        expectOwnedEvent("Hook Email: done", "main");
        expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith("main", "global");
        expect(deferHookWakeMock).not.toHaveBeenCalled();
      } else {
        expect(deferHookWakeMock).toHaveBeenCalledExactlyOnceWith({
          text: "Hook Email: done",
          agentId: "main",
          expectedTarget: {
            agentId: "main",
            sessionKey: "global",
            sessionId: "captured-session",
            generation: "captured-generation",
          },
          createIfMissing: true,
          commitGuard: expect.any(Function),
        });
        expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith("main", "global");
        expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["now", "next-heartbeat"] as const)(
    "does not recapture a failed %s terminal target after asynchronous preparation",
    async (wakeMode) => {
      captureSessionEventTargetMock.mockRejectedValueOnce(new Error("session target was replaced"));

      await expect(dispatch(payload({ wakeMode }))).resolves.toMatchObject({
        ok: false,
        statusCode: 502,
      });
      await warningObserved.promise;
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith("main", "global");
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      expect(deferHookWakeMock).not.toHaveBeenCalled();
      expect(logHooksWarnMock).toHaveBeenCalledWith(
        "hook terminal event not delivered",
        expect.objectContaining({
          error: "Hook terminal target could not be captured before the run",
        }),
      );
    },
  );

  it.each([
    {
      name: "the accepted agent is removed after success",
      outcome: "success" as const,
      wakeMode: "now" as const,
      status: "ok",
      reason: "accepted-agent-removed",
    },
    {
      name: "the accepted agent is removed after failure",
      outcome: "failure" as const,
      wakeMode: "now" as const,
      status: "error",
      reason: "accepted-agent-removed",
    },
    {
      name: "the accepted agent is removed before deferred success",
      outcome: "success" as const,
      wakeMode: "next-heartbeat" as const,
      status: "ok",
      reason: "accepted-agent-removed",
    },
    {
      name: "the accepted agent is removed before deferred failure",
      outcome: "failure" as const,
      wakeMode: "next-heartbeat" as const,
      status: "error",
      reason: "accepted-agent-removed",
    },
  ])("suppresses the terminal event when $name", async (testCase) => {
    const gate = await startGatedRun(testCase.outcome, testCase.wakeMode);
    loadConfigMock.mockReturnValue({
      ...globalConfig("work", false),
      hooks: { enabled: true, token: "test-token", allowedAgentIds: ["*"] },
    });
    gate.resolve();

    await warningObserved.promise;
    expect(logHooksWarnMock).toHaveBeenCalledWith(
      "hook agent terminal event suppressed",
      expect.objectContaining({
        acceptedAgentId: "main",
        status: testCase.status,
        reason: testCase.reason,
        runId: expect.any(String),
        jobId: expect.any(String),
      }),
    );
    expect(deferHookWakeMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });
});
