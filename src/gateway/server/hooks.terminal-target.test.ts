import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import type { HookAgentDispatchPayload as HookPayload } from "../hooks.js";

let terminalObserved = createDeferred();
let warningObserved = createDeferred();
const enqueueSystemEventMock = vi.fn((..._args: unknown[]) => {
  terminalObserved.resolve();
  return true;
});
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

vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: enqueueSystemEventMock,
}));
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

const { createGatewayHookDispatcher } = await import("./hooks.js");
let dispatch: ReturnType<typeof createGatewayHookDispatcher>["dispatchAgentHook"];

const payload = (wakeMode: HookPayload["wakeMode"] = "now"): HookPayload => ({
  message: "test message",
  name: "Email",
  effectiveAgentId: "main",
  wakeMode,
  sessionKey: "session-1",
  sessionMode: "isolated",
  sourcePath: "/hooks/agent",
  deliver: true,
  channel: "last",
  delivery: { mode: "none" },
});

const globalConfig = (systemAgentId: "main" | "work", includeMain = true): OpenClawConfig => ({
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: systemAgentId } },
    entries: includeMain ? { main: {}, work: {} } : { work: {} },
  },
  session: { scope: "global" },
});

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
  void dispatch(payload(wakeMode));
  await started.promise;
  return gate;
}

describe("global hook terminal target resolution", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    terminalObserved = createDeferred();
    warningObserved = createDeferred();
    loadConfigMock.mockReturnValue(globalConfig("main"));
    ({ dispatchAgentHook: dispatch } = createGatewayHookDispatcher({
      deps: {} as never,
      logHooks: {
        ...createSubsystemLogger("hook-terminal-test"),
        warn: logHooksWarnMock,
        info: vi.fn(),
      },
    }));
  });

  afterEach(resetGatewayWorkAdmission);

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
        const call = enqueueSessionEventMock.mock.calls.find(
          ([text]) => text === "Hook Email: done",
        );
        expect(call?.[1]).toMatchObject({
          agentId: "main",
          sessionKey: "global",
          expectedTarget: { agentId: "main", sessionKey: "global", sessionId: "captured-session" },
        });
        expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith("main", "global");
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      } else {
        expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith("Hook Email: done", {
          sessionKey: "agent:main:global",
        });
        expect(captureSessionEventTargetMock).not.toHaveBeenCalled();
        expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      }
    },
  );

  it("does not recapture a failed immediate terminal target after asynchronous preparation", async () => {
    captureSessionEventTargetMock.mockRejectedValueOnce(new Error("session target was replaced"));

    await expect(dispatch(payload())).resolves.toMatchObject({ ok: false, statusCode: 502 });
    await warningObserved.promise;
    expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
    expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith("main", "global");
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(logHooksWarnMock).toHaveBeenCalledWith(
      "hook terminal event not delivered",
      expect.objectContaining({
        error: "Hook terminal target could not be captured before the run",
      }),
    );
  });

  it.each(["success", "failure"] as const)(
    "suppresses the terminal event when the accepted agent is removed after %s",
    async (outcome) => {
      const gate = await startGatedRun(outcome);
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
          status: outcome === "success" ? "ok" : "error",
          reason: "accepted-agent-removed",
          runId: expect.any(String),
          jobId: expect.any(String),
        }),
      );
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    },
  );
});
