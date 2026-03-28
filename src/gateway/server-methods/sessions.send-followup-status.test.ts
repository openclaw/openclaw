import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
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

vi.mock("../../agents/subagent-registry-read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/subagent-registry-read.js")>();
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
  };
});

vi.mock("../session-subagent-reactivation.runtime.js", () => ({
  replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
}));

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
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
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
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(completedRun);
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
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock,
      broadcastToConnIds,
      completedRun,
      childSessionKey,
    });
  });

  it("interrupts active agent-owned session runs before steering a follow-up", async () => {
    const sessionKey = "agent:main:subagent:interrupt";
    const agentEntry: ChatAbortControllerEntry = {
      kind: "agent",
      controller: new AbortController(),
      sessionId: "sess-interrupt",
      sessionKey,
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };

    loadSessionEntryMock.mockReturnValue({
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-interrupt" },
    });
    readSessionMessagesMock.mockReturnValue([]);
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-new", status: "started" }, undefined, undefined);
    });

    const respond = vi.fn() as unknown as RespondFn;
    const context = {
      chatAbortControllers: new Map([["run-agent", agentEntry]]),
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      chatAbortedRuns: new Map(),
      removeChatRun: vi.fn(() => undefined),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    } as unknown as GatewayRequestContext;

    await sessionsHandlers["sessions.steer"]({
      req: { id: "req-2" } as never,
      params: {
        key: sessionKey,
        message: "follow-up",
        idempotencyKey: "run-new",
      },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(agentEntry.controller.signal.aborted).toBe(true);
    expect(context.chatAbortControllers.has("run-agent")).toBe(false);
    expect(chatSendMock).toHaveBeenCalledOnce();
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
  });
});
