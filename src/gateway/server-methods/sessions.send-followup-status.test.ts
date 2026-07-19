/**
 * Tests follow-up session send status transitions and broadcasts.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { clearFollowupQueue, getFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import { createSteeringAuthorizationAffinity } from "../../auto-reply/reply/steering-authorization-affinity.js";
import { createGatewayOperatorTurnAuthority } from "../operator-turn-authority.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const readSessionMessageCountAsyncMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const chatSendMock = vi.fn();
const chatAbortMock = vi.fn();

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
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
    "chat.abort": (...args: unknown[]) => chatAbortMock(...args),
    "chat.send": (...args: unknown[]) => chatSendMock(...args),
  },
}));

import { sessionsHandlers } from "./sessions.js";

describe("sessions.send completed subagent follow-up status", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessageCountAsyncMock.mockReset().mockResolvedValue(0);
    loadGatewaySessionRowMock.mockReset();
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    chatSendMock.mockReset();
    chatAbortMock.mockReset();
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

  it("sessions.steer fails closed for an unowned tracked run before mutation", async () => {
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "main",
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main" },
    });
    const controller = new AbortController();
    const context = {
      chatAbortControllers: new Map([
        [
          "run-unowned",
          {
            controller,
            sessionId: "sess-main",
            sessionKey: "main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;
    const respondMock = vi.fn();

    await expectDefined(
      sessionsHandlers["sessions.steer"],
      'sessionsHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-steer-unowned" } as never,
      params: { key: "main", message: "replace this run" },
      respond: respondMock as unknown as RespondFn,
      context,
      client: {
        connId: "conn-writer",
        connect: { device: { id: "dev-writer" }, scopes: ["operator.write"] },
      } as never,
      isWebchatConnect: () => false,
    });

    expect(respondMock.mock.calls.at(0)?.[0]).toBe(false);
    expect(respondMock.mock.calls.at(0)?.[2]?.message).toBe("unauthorized");
    expect(controller.signal.aborted).toBe(false);
    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(chatSendMock).not.toHaveBeenCalled();
  });

  it("sessions.steer rejects writer control of worker-only inference before cancellation", async () => {
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "main",
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-worker" },
    });
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = {
      chatAbortControllers: new Map(),
      workerEnvironmentService: {
        hasInferenceForSession: () => true,
        cancelInferenceForSession,
      },
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;
    const respondMock = vi.fn();

    await expectDefined(
      sessionsHandlers["sessions.steer"],
      'sessionsHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-steer-worker" } as never,
      params: { key: "main", message: "replace worker" },
      respond: respondMock as unknown as RespondFn,
      context,
      client: {
        connId: "conn-writer",
        connect: { device: { id: "dev-writer" }, scopes: ["operator.write"] },
      } as never,
      isWebchatConnect: () => false,
    });

    expect(respondMock.mock.calls.at(0)?.[0]).toBe(false);
    expect(respondMock.mock.calls.at(0)?.[2]?.message).toBe("unauthorized");
    expect(cancelInferenceForSession).not.toHaveBeenCalled();
    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(chatSendMock).not.toHaveBeenCalled();
  });

  it("sessions.steer lets admins replace worker-only inference without guessing queue lineage", async () => {
    const key = "agent:main:main";
    const sessionId = "sess-worker-admin";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: key,
      storePath: "/tmp/sessions.json",
      entry: { sessionId },
    });
    const adminClient = {
      connId: "conn-admin",
      connect: { device: { id: "dev-admin" }, scopes: ["operator.admin"] },
    } as GatewayClient;
    const turnAuthority = createGatewayOperatorTurnAuthority({
      client: adminClient,
      agentId: "main",
      sessionKey: key,
      sessionId,
      conversationId: key,
      trigger: "gateway",
    });
    const queue = getFollowupQueue(key, { mode: "followup" });
    queue.items.push({
      prompt: "admin queued work",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId,
        sessionKey: key,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        config: {},
        provider: "openai",
        model: "gpt-test",
        timeoutMs: 30_000,
        blockReplyBreak: "message_end",
        turnAuthority,
      },
    });
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = {
      chatAbortControllers: new Map(),
      workerEnvironmentService: {
        hasInferenceForSession: () => true,
        cancelInferenceForSession,
      },
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;
    const respondMock = vi.fn();
    chatAbortMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { ok: true, aborted: true, runIds: ["worker-run"] });
    });
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "replacement-run", status: "started" });
    });

    try {
      await expectDefined(
        sessionsHandlers["sessions.steer"],
        'sessionsHandlers["sessions.steer"] test invariant',
      )({
        req: { id: "req-steer-worker-admin" } as never,
        params: { key, message: "replace worker" },
        respond: respondMock as unknown as RespondFn,
        context,
        client: adminClient,
        isWebchatConnect: () => false,
      });

      expect(respondMock.mock.calls.at(0)?.[0]).toBe(true);
      expect(respondMock.mock.calls.at(0)?.[1]).toMatchObject({
        runId: "replacement-run",
        interruptedActiveRun: true,
      });
      expect(queue.items.map((item) => item.prompt)).toEqual(["admin queued work"]);
      expect(cancelInferenceForSession).not.toHaveBeenCalled();
      expect(chatAbortMock).toHaveBeenCalledTimes(1);
      expect(chatSendMock).toHaveBeenCalledTimes(1);
      expect(chatAbortMock.mock.invocationCallOrder[0]).toBeLessThan(
        chatSendMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      clearFollowupQueue(key);
    }
  });

  it("sessions.steer preserves foreign and unattributed queued follow-ups", async () => {
    const key = "agent:main:main";
    const sessionId = "sess-main-mixed";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: key,
      storePath: "/tmp/sessions.json",
      entry: { sessionId },
    });
    const client = {
      connId: "conn-writer",
      connect: { device: { id: "dev-writer" }, scopes: ["operator.write"] },
    } as GatewayClient;
    const foreignClient = {
      connId: "conn-foreign",
      connect: { device: { id: "dev-foreign" }, scopes: ["operator.write"] },
    } as GatewayClient;
    const controlledAffinity = createSteeringAuthorizationAffinity({
      turnAuthority: createGatewayOperatorTurnAuthority({
        client,
        agentId: "main",
        sessionKey: key,
        sessionId,
        conversationId: key,
        trigger: "sessions.steer",
      }),
    });
    const makeFollowup = (prompt: string, authorityClient?: GatewayClient): FollowupRun => ({
      prompt,
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId,
        sessionKey: key,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        config: {},
        provider: "openai",
        model: "gpt-test",
        timeoutMs: 30_000,
        blockReplyBreak: "message_end",
        ...(authorityClient
          ? {
              turnAuthority: createGatewayOperatorTurnAuthority({
                client: authorityClient,
                agentId: "main",
                sessionKey: key,
                sessionId,
                conversationId: key,
                trigger: "sessions.steer",
              }),
            }
          : {}),
      },
    });
    const queue = getFollowupQueue(key, { mode: "followup" });
    queue.items.push(
      makeFollowup("same controller", client),
      makeFollowup("foreign controller", foreignClient),
      makeFollowup("unattributed"),
    );
    const context = {
      chatAbortControllers: new Map([
        [
          "run-owned",
          {
            controller: new AbortController(),
            sessionId,
            sessionKey: key,
            ownerConnId: "conn-writer",
            ownerDeviceId: "dev-writer",
            steeringAuthorizationAffinity: controlledAffinity,
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;
    chatAbortMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { aborted: true });
    });
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-next", status: "started" });
    });
    const respondMock = vi.fn();

    try {
      await expectDefined(
        sessionsHandlers["sessions.steer"],
        'sessionsHandlers["sessions.steer"] test invariant',
      )({
        req: { id: "req-steer-mixed" } as never,
        params: { key, message: "replace my run" },
        respond: respondMock as unknown as RespondFn,
        context,
        client,
        isWebchatConnect: () => false,
      });

      expect(respondMock.mock.calls.at(0)?.[0]).toBe(true);
      expect(queue.items.map((item) => item.prompt)).toEqual([
        "foreign controller",
        "unattributed",
      ]);
      expect(queue.abortController.signal.aborted).toBe(false);
    } finally {
      clearFollowupQueue(key);
    }
  });

  it("sessions.steer clears every tracked-run affinity in a mixed worker session", async () => {
    const key = "agent:main:main";
    const sessionId = "sess-main-tracked-worker";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: key,
      storePath: "/tmp/sessions.json",
      entry: { sessionId },
    });
    const ownerOne = {
      connId: "conn-owner-one",
      connect: { device: { id: "dev-owner-one" }, scopes: ["operator.write"] },
    } as GatewayClient;
    const ownerTwo = {
      connId: "conn-owner-two",
      connect: { device: { id: "dev-owner-two" }, scopes: ["operator.write"] },
    } as GatewayClient;
    const adminClient = {
      connId: "conn-admin",
      connect: { device: { id: "dev-admin" }, scopes: ["operator.admin"] },
    } as GatewayClient;
    const createAuthority = (client: GatewayClient) =>
      createGatewayOperatorTurnAuthority({
        client,
        agentId: "main",
        sessionKey: key,
        sessionId,
        conversationId: key,
        trigger: "gateway",
      });
    const createFollowup = (prompt: string, client?: GatewayClient): FollowupRun => ({
      prompt,
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId,
        sessionKey: key,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        config: {},
        provider: "openai",
        model: "gpt-test",
        timeoutMs: 30_000,
        blockReplyBreak: "message_end",
        ...(client ? { turnAuthority: createAuthority(client) } : {}),
      },
    });
    const queue = getFollowupQueue(key, { mode: "followup" });
    queue.items.push(
      createFollowup("owner one queued work", ownerOne),
      createFollowup("owner two queued work", ownerTwo),
      createFollowup("admin queued work", adminClient),
      createFollowup("unattributed"),
    );
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = {
      chatAbortControllers: new Map([
        [
          "run-owner-one",
          {
            controller: new AbortController(),
            sessionId,
            sessionKey: key,
            ownerConnId: ownerOne.connId,
            ownerDeviceId: ownerOne.connect?.device?.id,
            steeringAuthorizationAffinity: createSteeringAuthorizationAffinity({
              turnAuthority: createAuthority(ownerOne),
            }),
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
        [
          "run-owner-two",
          {
            controller: new AbortController(),
            sessionId,
            sessionKey: key,
            ownerConnId: ownerTwo.connId,
            ownerDeviceId: ownerTwo.connect?.device?.id,
            steeringAuthorizationAffinity: createSteeringAuthorizationAffinity({
              turnAuthority: createAuthority(ownerTwo),
            }),
            startedAtMs: 2,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      workerEnvironmentService: {
        hasInferenceForSession: () => true,
        cancelInferenceForSession,
      },
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;
    chatAbortMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { aborted: true });
    });
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-next", status: "started" });
    });
    const respondMock = vi.fn();

    try {
      await expectDefined(
        sessionsHandlers["sessions.steer"],
        'sessionsHandlers["sessions.steer"] test invariant',
      )({
        req: { id: "req-steer-tracked-worker" } as never,
        params: { key, message: "replace tracked runs" },
        respond: respondMock as unknown as RespondFn,
        context,
        client: adminClient,
        isWebchatConnect: () => false,
      });

      expect(respondMock.mock.calls.at(0)?.[0]).toBe(true);
      expect(queue.items.map((item) => item.prompt)).toEqual(["admin queued work", "unattributed"]);
      expect(chatAbortMock).toHaveBeenCalledTimes(1);
      expect(cancelInferenceForSession).not.toHaveBeenCalled();
    } finally {
      clearFollowupQueue(key);
    }
  });

  it("sessions.steer clears the controlled run queue when an admin aborts it", async () => {
    const key = "agent:main:main";
    const sessionId = "sess-main-admin-steer";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: key,
      storePath: "/tmp/sessions.json",
      entry: { sessionId },
    });
    const ownerClient = {
      connId: "conn-owner",
      connect: { device: { id: "dev-owner" }, scopes: ["operator.write"] },
    } as GatewayClient;
    const adminClient = {
      connId: "conn-admin",
      connect: { device: { id: "dev-admin" }, scopes: ["operator.admin"] },
    } as GatewayClient;
    const foreignClient = {
      connId: "conn-foreign",
      connect: { device: { id: "dev-foreign" }, scopes: ["operator.write"] },
    } as GatewayClient;
    const createAuthority = (client: GatewayClient) =>
      createGatewayOperatorTurnAuthority({
        client,
        agentId: "main",
        sessionKey: key,
        sessionId,
        conversationId: key,
        trigger: "sessions.steer",
      });
    const ownerAffinity = createSteeringAuthorizationAffinity({
      turnAuthority: createAuthority(ownerClient),
    });
    const makeFollowup = (prompt: string, authorityClient?: GatewayClient): FollowupRun => ({
      prompt,
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId,
        sessionKey: key,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        config: {},
        provider: "openai",
        model: "gpt-test",
        timeoutMs: 30_000,
        blockReplyBreak: "message_end",
        ...(authorityClient ? { turnAuthority: createAuthority(authorityClient) } : {}),
      },
    });
    const queue = getFollowupQueue(key, { mode: "followup" });
    queue.items.push(
      makeFollowup("controlled run follow-up", ownerClient),
      makeFollowup("foreign follow-up", foreignClient),
      makeFollowup("unattributed"),
    );
    const handle: Parameters<typeof setActiveEmbeddedRun>[1] = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      steeringAuthorizationAffinity: ownerAffinity,
      abort: () => clearActiveEmbeddedRun(sessionId, handle, key),
    };
    setActiveEmbeddedRun(sessionId, handle, key);
    const context = {
      chatAbortControllers: new Map(),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-next", status: "started" });
    });
    const respondMock = vi.fn();

    try {
      await expectDefined(
        sessionsHandlers["sessions.steer"],
        'sessionsHandlers["sessions.steer"] test invariant',
      )({
        req: { id: "req-steer-admin" } as never,
        params: { key, message: "replace controlled run" },
        respond: respondMock as unknown as RespondFn,
        context,
        client: adminClient,
        isWebchatConnect: () => false,
      });

      expect(respondMock.mock.calls.at(0)?.[0]).toBe(true);
      expect(queue.items.map((item) => item.prompt)).toEqual(["foreign follow-up", "unattributed"]);
      expect(chatAbortMock).not.toHaveBeenCalled();
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, key);
      clearFollowupQueue(key);
    }
  });
});
