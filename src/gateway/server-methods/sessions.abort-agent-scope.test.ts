import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const resolveSessionKeyForRunMock = vi.fn();

vi.mock("../server-session-key.js", () => ({
  resolveSessionKeyForRun: (...args: unknown[]) => resolveSessionKeyForRunMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.abort": (...args: unknown[]) => chatAbortMock(...args),
  },
}));

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
  });

  it("does not abort an active run whose session key belongs to another agent", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = {
      chatAbortControllers: new Map([["run-beta", activeRun]]),
      getRuntimeConfig: () => ({
        agents: [{ id: "main", default: true }, { id: "beta" }],
      }),
    } as unknown as GatewayRequestContext;
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-1" } as never,
      params: { runId: "run-beta" },
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
});
