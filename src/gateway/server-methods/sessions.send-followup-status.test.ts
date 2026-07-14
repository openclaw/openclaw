/**
 * Tests follow-up session send status transitions and broadcasts.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const readSessionMessageCountAsyncMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const chatSendMock = vi.fn();

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    readSessionMessages: (...args: unknown[]) => readSessionMessagesMock(...args),
    loadGatewaySessionRow: (...args: unknown[]) => loadGatewaySessionRowMock(...args),
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readSessionMessageCountAsync: (...args: unknown[]) => readSessionMessageCountAsyncMock(...args),
  };
});

vi.mock("../../agents/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/subagent-registry-read.js")>(
    "../../agents/subagent-registry-read.js",
  );
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
    readSessionMessageCountAsyncMock.mockReset();
    readSessionMessageCountAsyncMock.mockResolvedValue(0);
    loadGatewaySessionRowMock.mockReset();
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    chatSendMock.mockReset();
  });

  it("coord.messages.send routes canonical coordination messages with provenance", async () => {
    const coordSessionKey = "agent:main:codex-coord";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: coordSessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-coord" },
    });
    readSessionMessagesMock.mockReturnValue([]);
    chatSendMock.mockImplementation(
      async ({ params, respond }: { params: unknown; respond: RespondFn }) => {
        expect(params).toMatchObject({
          sessionKey: coordSessionKey,
          idempotencyKey: "coord-run-1",
        });
        expect((params as { message?: string }).message).toContain(
          "sourceTool=coord_messages_send",
        );
        expect((params as { message?: string }).message).toContain("coord hello");
        respond(true, { runId: "coord-run-1", status: "started" }, undefined, undefined);
      },
    );

    const respondMock = vi.fn();
    const respond = respondMock as unknown as RespondFn;
    const context = {
      chatAbortControllers: new Map(),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;

    await expectDefined(
      sessionsHandlers["coord.messages.send"],
      'sessionsHandlers["coord.messages.send"] test invariant',
    )({
      req: { id: "req-1" } as never,
      params: {
        sessionKey: coordSessionKey,
        message: "coord hello",
        idempotencyKey: "coord-run-1",
      },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "coord-run-1", status: "started", messageSeq: 1 }),
      undefined,
      undefined,
    );
  });

  it("coord.messages.send rejects non-canonical coordination keys before chat dispatch", async () => {
    const respondMock = vi.fn();
    const respond = respondMock as unknown as RespondFn;
    const context = {
      chatAbortControllers: new Map(),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;

    await expectDefined(
      sessionsHandlers["coord.messages.send"],
      'sessionsHandlers["coord.messages.send"] test invariant',
    )({
      req: { id: "req-1" } as never,
      params: {
        sessionKey: "agent:main:explicit:codex-coord",
        message: "do not send",
      },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).not.toHaveBeenCalled();
    expect(respondMock.mock.calls[0]?.[0]).toBe(false);
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
      cfg: {},
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
    const respondMock = vi.fn();
    const respond = respondMock as unknown as RespondFn;
    const context = {
      chatAbortControllers: new Map(),
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;

    await expectDefined(
      sessionsHandlers["sessions.send"],
      'sessionsHandlers["sessions.send"] test invariant',
    )({
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

    const call = respondMock.mock.calls.at(0) as
      | [boolean, { runId?: string; status?: string; messageSeq?: number }, unknown?, unknown?]
      | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]?.runId).toBe("run-new");
    expect(call?.[1]?.status).toBe("started");
    expect(call?.[1]?.messageSeq).toBe(1);
    expect(call?.[2]).toBeUndefined();
    expect(call?.[3]).toBeUndefined();
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock,
      broadcastToConnIds,
      completedRun,
      childSessionKey,
      task: "follow-up",
    });
  });

  for (const method of ["sessions.send", "sessions.steer"] as const) {
    it(`${method} passes selected-global agent scope through chat.send`, async () => {
      const cfg = { agents: { list: [{ id: "main", default: true }, { id: "work" }] } };
      loadSessionEntryMock.mockReturnValue({
        cfg,
        canonicalKey: "global",
        storePath: "/tmp/work/sessions.json",
        entry: { sessionId: "sess-work-global" },
      });
      readSessionMessagesMock.mockReturnValue([]);
      loadGatewaySessionRowMock.mockReturnValue(null);
      chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
        respond(true, { runId: "run-work", status: "started" }, undefined, undefined);
      });

      const respondMock = vi.fn();
      const respond = respondMock as unknown as RespondFn;
      const context = {
        chatAbortControllers: new Map(),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        getRuntimeConfig: () => cfg,
      } as unknown as GatewayRequestContext;

      await expectDefined(
        sessionsHandlers[method],
        "sessionsHandlers[method] test invariant",
      )({
        req: { id: "req-1" } as never,
        params: {
          key: "global",
          agentId: "work",
          message: "follow-up",
          idempotencyKey: "run-work",
        },
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });

      expect(loadSessionEntryMock).toHaveBeenCalledWith("global", { agentId: "work" });
      const chatSendCall = chatSendMock.mock.calls.at(0)?.[0] as
        | { params?: Record<string, unknown> }
        | undefined;
      expect(chatSendCall?.params).toMatchObject({
        sessionKey: "global",
        agentId: "work",
        message: "follow-up",
      });
      expect(respondMock.mock.calls.at(0)?.[0]).toBe(true);
    });
  }
});
