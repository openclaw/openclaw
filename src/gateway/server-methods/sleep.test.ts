import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionSleeps } from "../../infra/session-sleep.js";
import type { GatewayRequestHandler } from "./types.js";

const mocks = vi.hoisted(() => ({
  agentRunHandler: vi.fn(),
}));

vi.mock("./agent-run-handler.js", () => ({
  agentRunHandler: mocks.agentRunHandler,
}));

const { sleepHandlers } = await import("./sleep.js");

function sleepHandler(): GatewayRequestHandler {
  const handler = sleepHandlers["sleep.schedule"];
  if (!handler) {
    throw new Error("missing sleep.schedule handler");
  }
  return handler;
}

function invoke(params: Record<string, unknown>, sessionKey?: string) {
  const respond = vi.fn();
  const logError = vi.fn();
  void sleepHandler()({
    req: { type: "req", id: "request-1", method: "sleep.schedule", params },
    params,
    respond,
    client: {
      connect: {} as never,
      internal: sessionKey
        ? {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey,
            },
          }
        : undefined,
    },
    context: { logGateway: { error: logError } } as never,
    isWebchatConnect: () => false,
  });
  return { respond, logError };
}

describe("sleep.schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.agentRunHandler.mockReset();
    mocks.agentRunHandler.mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearSessionSleeps();
    vi.useRealTimers();
  });

  it("requires the signed caller session identity", () => {
    const { respond } = invoke(
      { seconds: 10, message: "resume", sessionKey: "agent:main:one" },
      "agent:main:other",
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("matching agent runtime") }),
    );
  });

  it("fires a normal agent turn in the same session with the caller tool surface", async () => {
    const sessionKey = "agent:main:one";
    const { respond } = invoke(
      {
        seconds: 10,
        message: "resume pending work",
        sessionKey,
        toolsAllow: ["read", "exec"],
      },
      sessionKey,
    );

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true, sessionKey }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.agentRunHandler).toHaveBeenCalledOnce();
    expect(mocks.agentRunHandler.mock.calls[0]?.[0]).toMatchObject({
      params: {
        message: "resume pending work",
        agentId: "main",
        sessionKey,
        deliver: true,
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: sessionKey,
          sourceTool: "sleep",
        },
      },
      client: {
        internal: {
          sleepToolsAllow: ["read", "exec"],
        },
      },
    });
  });
});
