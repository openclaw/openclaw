import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeferredHookWake } from "../../cron/service/wake.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";

const enqueueSystemEventMock = vi.fn();
const deferHookWakeMock = vi.fn<DeferredHookWake>();
let terminalEventObserved = createDeferred();
const captureSessionEventTargetMock = vi.fn(async (agentId: string, sessionKey: string) => ({
  agentId,
  sessionKey,
  sessionId: "accepted-session",
}));
const enqueueSessionEventMock = vi.fn((_text: string, _options: Record<string, unknown>) => {
  terminalEventObserved.resolve();
  return { settled: Promise.resolve({ status: "completed" }) };
});
const runCronIsolatedAgentTurnMock = vi.fn();
const loadConfigMock = vi.fn<() => OpenClawConfig>();
const logHooksWarnMock = vi.fn();

vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: enqueueSystemEventMock,
}));
// mock-isolation: Observe the terminal wake destination without admitting a real follow-up turn.
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
    expectedTarget: { agentId, sessionKey: "global", sessionId: "accepted-session" },
  });
}

async function startGatedRun(
  result: "success" | "failure",
  wakeMode: "now" | "next-heartbeat" = "now",
) {
  const gate = createDeferred();
  runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
    await gate.promise;
    if (result === "failure") {
      throw new Error("agent exploded");
    }
    return { status: "ok", summary: "done", delivered: false, deliveryAttempted: false };
  });
  void dispatch(payload({ wakeMode }));
  await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));
  return gate;
}

describe("global hook terminal target resolution", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    terminalEventObserved = createDeferred();
    deferHookWakeMock.mockImplementation(async ({ commitGuard }) => {
      commitGuard();
      terminalEventObserved.resolve();
      return { ok: true, eventOutcome: "queued" };
    });
    loadConfigMock.mockReturnValue(globalConfig("main"));
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler({
      scheduler: createTestGatewayScheduler("fake-timers"),
      deps: {} as never,
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
      deferHookWake: deferHookWakeMock,
    });
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it.each(["now", "next-heartbeat"] as const)(
    "keeps the captured %s terminal target when hooks are disabled and the system agent changes",
    async (wakeMode) => {
      const gate = await startGatedRun("success", wakeMode);
      loadConfigMock.mockReturnValue({
        ...globalConfig("work"),
        hooks: { enabled: false },
      });
      gate.resolve();
      await terminalEventObserved.promise;

      if (wakeMode === "now") {
        expectOwnedEvent("Hook Email: done", "main");
      } else {
        expect(deferHookWakeMock).toHaveBeenCalledExactlyOnceWith({
          text: "Hook Email: done",
          agentId: "main",
          expectedTarget: {
            agentId: "main",
            sessionKey: "global",
            sessionId: "accepted-session",
          },
          commitGuard: expect.any(Function),
        });
        expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      }
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith("main", "global");
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
      name: "the accepted agent is removed before next-heartbeat completion",
      outcome: "success" as const,
      wakeMode: "next-heartbeat" as const,
      status: "ok",
      reason: "accepted-agent-removed",
    },
  ])("suppresses the terminal event when $name", async (testCase) => {
    const gate = await startGatedRun(testCase.outcome, testCase.wakeMode);
    loadConfigMock.mockReturnValue({
      ...globalConfig("work", false),
      hooks: { enabled: true, token: "test-token", allowedAgentIds: ["*"] },
    });
    gate.resolve();

    await vi.waitFor(() =>
      expect(logHooksWarnMock).toHaveBeenCalledWith(
        "hook agent terminal event suppressed",
        expect.objectContaining({
          acceptedAgentId: "main",
          status: testCase.status,
          reason: testCase.reason,
          runId: expect.any(String),
          jobId: expect.any(String),
        }),
      ),
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(deferHookWakeMock).not.toHaveBeenCalled();
  });
});
