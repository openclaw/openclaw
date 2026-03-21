import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();
const getSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const chatSendMock = vi.fn();

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    readSessionMessages: (...args: unknown[]) => readSessionMessagesMock(...args),
    loadGatewaySessionRow: (...args: unknown[]) => loadGatewaySessionRowMock(...args),
  };
});

vi.mock("../../agents/subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/subagent-registry.js")>();
  return {
    ...actual,
    getSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getSubagentRunByChildSessionKeyMock(...args),
    replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
  };
});

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": (...args: unknown[]) => chatSendMock(...args),
  },
}));

import { sessionsHandlers } from "./sessions.js";

describe("sessions.send completed subagent follow-up status", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessagesMock.mockReset();
    loadGatewaySessionRowMock.mockReset();
    getSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    chatSendMock.mockReset();
  });

  it("reactivates completed subagent sessions before broadcasting sessions.changed", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const completedRun = {
      runId: "run-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep" as const,
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" as const },
    };

    loadSessionEntryMock.mockReturnValue({
      canonicalKey: childSessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-followup" },
    });
    readSessionMessagesMock.mockReturnValue([]);
    getSubagentRunByChildSessionKeyMock.mockReturnValue(completedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);
    loadGatewaySessionRowMock.mockReturnValue({
      status: "running",
      startedAt: 123,
      endedAt: undefined,
      runtimeMs: 10,
    });
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-new", status: "started" }, undefined, undefined);
    });

    const broadcastToConnIds = vi.fn();
    const respond = vi.fn() as unknown as RespondFn;
    const context = {
      chatAbortControllers: new Map(),
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
    } as unknown as GatewayRequestContext;

    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: {
        key: childSessionKey,
        message: "follow-up",
        idempotencyKey: "run-new",
      },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "run-new",
        status: "started",
        messageSeq: 1,
      }),
      undefined,
      undefined,
    );
    expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
      previousRunId: "run-old",
      nextRunId: "run-new",
      fallback: completedRun,
      runTimeoutSeconds: 0,
    });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: childSessionKey,
        reason: "send",
        status: "running",
        startedAt: 123,
        endedAt: undefined,
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });
});
