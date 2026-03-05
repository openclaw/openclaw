import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookAgentDispatchPayload } from "../hooks.js";

const {
  loadConfigMock,
  resolveMainSessionKeyFromConfigMock,
  runCronIsolatedAgentTurnMock,
  requestHeartbeatNowMock,
  enqueueSystemEventMock,
  createHooksRequestHandlerMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({})),
  resolveMainSessionKeyFromConfigMock: vi.fn(() => "agent:main"),
  runCronIsolatedAgentTurnMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  enqueueSystemEventMock: vi.fn(),
  createHooksRequestHandlerMock: vi.fn((deps) => deps),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    resolveMainSessionKeyFromConfig: resolveMainSessionKeyFromConfigMock,
  };
});

vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: requestHeartbeatNowMock,
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));

vi.mock("../server-http.js", () => ({
  createHooksRequestHandler: createHooksRequestHandlerMock,
}));

import { createGatewayHooksRequestHandler } from "./hooks.js";

type HooksHarness = {
  dispatchAgentHook: (value: HookAgentDispatchPayload) => string;
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
};

function createHarness() {
  return createGatewayHooksRequestHandler({
    deps: {} as never,
    getHooksConfig: () => null,
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as never,
  }) as unknown as HooksHarness;
}

function createPayload(overrides?: Partial<HookAgentDispatchPayload>): HookAgentDispatchPayload {
  return {
    message: "summarize recent alerts",
    name: "alert-hook",
    wakeMode: "now",
    sessionKey: "hook:alerts",
    deliver: true,
    channel: "last",
    ...overrides,
  };
}

describe("createGatewayHooksRequestHandler deliver=false behavior", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveMainSessionKeyFromConfigMock.mockReset();
    runCronIsolatedAgentTurnMock.mockReset();
    requestHeartbeatNowMock.mockReset();
    enqueueSystemEventMock.mockReset();
    createHooksRequestHandlerMock.mockReset();

    loadConfigMock.mockReturnValue({});
    resolveMainSessionKeyFromConfigMock.mockReturnValue("agent:main");
    createHooksRequestHandlerMock.mockImplementation((deps) => deps);
  });

  it("does not inject fallback main-session summary when deliver=false", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValue({
      status: "ok",
      summary: "done",
      delivered: false,
      deliveryAttempted: false,
    });
    const harness = createHarness();

    harness.dispatchAgentHook(createPayload({ deliver: false }));

    await vi.waitFor(() => {
      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1);
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });

  it("keeps fallback main-session summary behavior when delivery is enabled", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValue({
      status: "ok",
      summary: "done",
      delivered: false,
      deliveryAttempted: false,
    });
    const harness = createHarness();

    harness.dispatchAgentHook(createPayload({ deliver: true }));

    await vi.waitFor(() => {
      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Hook alert-hook: done", {
      sessionKey: "agent:main",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/^hook:/),
      }),
    );
  });
});
