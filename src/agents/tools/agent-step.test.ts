import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import {
  readSessionSendDelivery,
  readSessionSendDeliveryAdmission,
  type SessionSendDelivery,
} from "../../gateway/session-send-delivery.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { runAgentStep } from "./agent-step.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { prepareSessionsSendCommunication } from "./sessions-send-communication.js";
import {
  finishSessionsSendReply,
  prepareSessionsSendReplyContext,
} from "./sessions-send-reply-flow.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import { startSessionsSendAgentRun } from "./sessions-send-tool.delivery.js";

const peer = vi.hoisted(() => ({
  config: undefined as OpenClawConfig | undefined,
  load: vi.fn(),
}));
function sessionEntry(name: string, communication?: SessionEntry["communication"]): SessionEntry {
  return {
    sessionId: `${name}-id`,
    lifecycleRevision: `${name}-v1`,
    updatedAt: 1,
    ...(communication ? { communication } : {}),
  };
}
vi.mock("./in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./in-process-gateway.js")>()),
  getInProcessGatewayToolContext: () =>
    peer.config ? { getRuntimeConfig: () => peer.config } : undefined,
}));
vi.mock("../../gateway/session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/session-utils-store-worker.js")>()),
  resolveGatewaySessionStoreTargetInWorker: peer.load,
}));

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-participant-recording.js")>()),
  recordSessionParticipantBestEffort: recordParticipant,
}));

const agentWaitMock = vi.hoisted(() => vi.fn());

afterEach(() => {
  agentWaitMock.mockReset();
  peer.config = undefined;
  peer.load.mockReset();
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
});

it("surfaces a failed accepted requester continuation without redispatching the peer result", async () => {
  const failure = "Codex thread synthetic-thread is claimed by active work; stop it first.";
  const config: OpenClawConfig = {
    tools: { sessions: { visibility: "all" } },
    session: { communication: { send: "always", receive: "always" } },
  };
  peer.config = config;
  setRuntimeConfigSnapshot(config);
  const requesterKey = "agent:main:requester";
  const peerKey = "agent:main:peer";
  const requester = {
    sessionId: "requester-id",
    lifecycleRevision: "requester-v1",
    updatedAt: 1,
  };
  const recipient = { sessionId: "peer-id", lifecycleRevision: "peer-v1", updatedAt: 1 };
  const rows = { [requesterKey]: requester, [peerKey]: recipient };
  peer.load.mockImplementation(async ({ key }: { key: string }) => ({
    agentId: "main",
    canonicalKey: key,
    storePath: "/fixture/sessions",
    store: rows,
  }));
  const provenance = {
    kind: "inter_session" as const,
    sourceTool: "sessions_send",
    sourceSessionKey: requesterKey,
  };
  const original = await prepareSessionsSendCommunication({
    config,
    source: {
      agentId: "main",
      sessionKey: requesterKey,
      storePath: "/fixture/sessions",
      entry: requester,
    },
    target: {
      agentId: "main",
      sessionKey: peerKey,
      storePath: "/fixture/sessions",
      entry: recipient,
    },
    message: "original request",
    inputProvenance: provenance,
    callGateway: async <T>(request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
      request.sessionMutationCommitGuard?.();
      return { runId: "completed-peer-run" } as T;
    },
  });
  let replyAdmission: ReturnType<typeof original.captureReplyAdmission>;
  try {
    expect(() => original.captureReplyAdmission("completed-peer-run")).toThrow(
      "no accepted source request",
    );
    await original.callGateway({
      method: "agent",
      params: {
        agentId: "main",
        sessionKey: peerKey,
        message: "original request",
        inputProvenance: provenance,
        idempotencyKey: "completed-peer-run",
      },
    });
    replyAdmission = original.captureReplyAdmission("completed-peer-run");
  } finally {
    original.close();
  }
  const gatewayCalls: CallGatewayOptions[] = [];
  const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
    gatewayCalls.push(opts);
    if (opts.method === "agent") {
      return { runId: "accepted-requester-run" } as T;
    }
    if (opts.method === "agent.wait") {
      return { status: "error", error: failure, endedAt: 1234 } as T;
    }
    throw new Error(`Unexpected Gateway request: ${opts.method}`);
  };

  await expect(
    runSessionsSendA2AFlow({
      callGateway,
      targetSessionKey: "agent:main:peer",
      targetAgentId: "main",
      displayKey: "peer",
      runId: "completed-peer-run",
      replyTimeoutMs: 10_000,
      requesterSessionKey: requesterKey,
      requesterAgentId: "main",
      requesterSession: requester,
      targetSession: recipient,
      replyAdmission,
      reply: {
        status: "ok",
        replyText: "Synthetic peer result",
        terminalReply: { disposition: "visible", text: "Synthetic peer result" },
      },
      deliverRequesterReply: (reply) =>
        runAgentStep({
          ...reply,
          agentId: "main",
          sessionKey: requesterKey,
          sourceAgentId: "main",
          sourceSessionKey: peerKey,
          expectedSession: requester,
          expectedSourceSession: recipient,
          replyAdmission,
          timeoutMs: 10_000,
          callGateway,
        }),
    }),
  ).rejects.toThrow(failure);
  expect(gatewayCalls.map((call) => call.method)).toEqual(["agent", "agent.wait"]);
});

it.each([false, true])(
  "preserves the nested runtime until terminal reply (queued=%s)",
  async (queued) => {
    const replies = [
      ...(queued ? [{ status: "pending", timeoutPhase: "queue" }, { status: "timeout" }] : []),
      {
        status: "ok",
        terminalReply: { disposition: "visible", text: queued ? "late reply" : "done" },
      },
    ];
    const gatewayCalls: CallGatewayOptions[] = [];
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
      if (opts.method === "agent.wait") {
        return await agentWaitMock(opts);
      }
      gatewayCalls.push(opts);
      return { runId: queued ? "run-pending" : "run-nested" } as T;
    };
    for (const reply of replies) {
      agentWaitMock.mockResolvedValueOnce(reply);
    }
    setRuntimeConfigSnapshot({});

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        ...(!queued ? { agentId: "main", sourceAgentId: "research" } : {}),
        sourceTool: "subagent_announce",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();

    expect(gatewayCalls[0]).toMatchObject({
      replyExpectation: "optional",
      params: {
        message: expect.stringContaining("[Inter-session message"),
        sessionKey: "agent:main:subagent:child",
        deliver: false,
        sourceReplyDeliveryMode: "message_tool_only",
        lane: "nested:agent:main:subagent:child",
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      },
    });
    const params = gatewayCalls[0]?.params as { message?: string } | undefined;
    expect(params?.message).toContain("isUser=false");
    expect(params?.message).toContain("hello");
    expect(agentWaitMock).toHaveBeenCalledTimes(replies.length);
    if (!queued) {
      expect(recordParticipant.mock.calls).toEqual([
        [
          expect.objectContaining({
            identity: { type: "agent", id: "research" },
            agentId: "main",
            sessionKey: "agent:main:subagent:child",
            promptedAt: expect.any(Number),
          }),
        ],
      ]);
    }
  },
);

it.each(["direct", "cron-fallback", "receive-only", "ask-send", "send-only"] as const)(
  "admits %s peer results durably under the captured session incarnations",
  async (route) => {
    const config: OpenClawConfig = {
      tools: { sessions: { visibility: "all" } },
      session: { communication: { send: "always", receive: "always" } },
    };
    if (route === "send-only") {
      config.agents = {
        entries: {
          main: { tools: { agentToAgent: { send: ["research"] } } },
          research: { tools: { agentToAgent: { send: [] } } },
        },
      };
      config.tools = {
        sessions: { visibility: "self" },
        agentToAgent: { enabled: true, allow: ["main", "research"] },
      };
    }
    peer.config = config;
    setRuntimeConfigSnapshot(config);
    const peerAgentId = route === "send-only" ? "research" : "main";
    const sourceKey = `agent:${peerAgentId}:peer`;
    const targetKey = "agent:main:requester";
    const restricted = route === "receive-only" || route === "ask-send";
    const source = sessionEntry(
      "peer",
      restricted ? { send: route === "ask-send" ? "ask" : "never" } : undefined,
    );
    const target = sessionEntry("requester", restricted ? { receive: "never" } : undefined);
    const rows: Record<string, SessionEntry> = { [sourceKey]: source, [targetKey]: target };
    const storeTarget = (key: string) => ({
      agentId: key === sourceKey ? peerAgentId : "main",
      canonicalKey: key,
      storePath: "/fixture/sessions",
      store: rows,
    });
    peer.load.mockImplementation(async ({ key }: { key: string }) => storeTarget(key));
    const endpoint = (agentId: string, sessionKey: string, entry: SessionEntry) => ({
      agentId,
      sessionKey,
      entry,
      storePath: "/fixture/sessions",
    });
    const requester = endpoint("main", targetKey, target);
    const peerEndpoint = endpoint(peerAgentId, sourceKey, source);
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceTool: "sessions_send",
      sourceSessionKey: targetKey,
    };
    const reply = {
      status: "ok" as const,
      replyText: "completed peer result",
      terminalReply: { disposition: "visible" as const, text: "completed peer result" },
    };
    const original = await prepareSessionsSendCommunication({
      config,
      source: requester,
      target: peerEndpoint,
      message: "original request",
      inputProvenance,
      callGateway: async <T>() => ({ runId: "peer-run" }) as T,
    });
    expect(() => original.captureReplyAdmission("peer-run")).toThrow("no accepted source request");
    await original.callGateway({
      method: "agent",
      params: {
        agentId: peerAgentId,
        sessionKey: sourceKey,
        message: "original request",
        idempotencyKey: "peer-run",
        inputProvenance,
      },
    });
    expect(() => original.captureReplyAdmission("another-run")).toThrow(
      "no accepted source request",
    );
    const replyAdmission = original.captureReplyAdmission("peer-run");
    original.close();
    const admitted: SessionSendDelivery[] = [];
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => {
      if (request.method === "agent.wait") {
        return { status: "ok", terminalReply: { disposition: "silent" } } as T;
      }
      const params = request.params as { idempotencyKey: string; message: string };
      request.sessionMutationCommitGuard?.();
      const admission = readSessionSendDeliveryAdmission({
        agentId: "main",
        sessionKey: targetKey,
        sessionId: target.sessionId,
        runId: params.idempotencyKey,
      });
      expect(admission).toBeDefined();
      const persisted = buildPersistedUserTurnMessage({
        text: params.message,
        idempotencyKey: `${params.idempotencyKey}:user`,
        provenance: {
          kind: "inter_session",
          sourceTool: "sessions_send",
          sourceSessionKey: sourceKey,
        },
      });
      const persistedJson = JSON.stringify({
        ...persisted,
        __openclaw: { sessionSendDelivery: admission!.delivery },
      });
      const retained = readSessionSendDelivery(JSON.parse(persistedJson));
      expect(retained).toBeDefined();
      admitted.push(retained!);
      return { runId: params.idempotencyKey } as T;
    };
    const context = prepareSessionsSendReplyContext({
      callerOwnsCompletion: false,
      requesterIsSubagent: false,
      ownedTask: false,
      isIsolatedCronRequester: false,
      targetIsSubagent: false,
      requesterSessionKey: targetKey,
      targetSession:
        route === "cron-fallback" ? { ...source, sessionId: "expired-cron-run" } : source,
      requesterTarget: { ...storeTarget(targetKey), storeKeys: [targetKey] },
      context: {
        callGateway,
        targetSessionKey: sourceKey,
        targetAgentId: peerAgentId,
        replyAdmission,
        displayKey: sourceKey,
        replyTimeoutMs: 10_000,
        requesterSessionKey: targetKey,
        requesterAgentId: "main",
      },
    });
    if (route === "cron-fallback") {
      const start = await startSessionsSendAgentRun({
        cfg: config,
        admissionConfig: config,
        callGateway: async () => {
          throw new Error("Fallback used original target transport");
        },
        runId: "original-cron-run",
        sessionKey: "agent:main:cron:job:run:expired",
        sessionStoreTarget: {
          agentId: "main",
          canonicalKey: "agent:main:cron:job:run:expired",
          storePath: "/fixture/sessions",
        },
        sendParams: {
          message: "request",
          agentId: "main",
          inputProvenance,
          deliver: false,
          sourceReplyDeliveryMode: "message_tool_only",
        },
        fallbackSessionKey: sourceKey,
        prepareFallback: async () => ({
          targetSession: source,
          captureReplyAdmission: () => replyAdmission,
          assertCurrent() {},
          close() {},
          callGateway: async <T>() => ({ runId: "fallback-run" }) as T,
        }),
      });
      const followupGateway: AgentToolGatewayRequestCaller = async <T>(
        request: Parameters<AgentToolGatewayRequestCaller>[0],
      ) => (request.method === "agent.wait" ? (reply as T) : callGateway<T>(request));
      await finishSessionsSendReply({
        start,
        registryCompletion: false,
        watchField: {},
        replyContext: { ...context, callGateway: followupGateway },
        targetSession: { ...storeTarget(sourceKey), storeKeys: [sourceKey] },
        cfg: config,
        requesterAgentId: "main",
        promptedAt: Date.now(),
        timeoutSeconds: 0,
        timeoutMs: 10_000,
        targetIsSubagent: false,
        isIsolatedCronRequester: false,
      });
      await vi.waitFor(() => expect(admitted).toHaveLength(1));
    } else {
      await runSessionsSendA2AFlow({
        ...context,
        runId: "peer-run",
        reply,
      });
    }
    expect(admitted).toMatchObject([
      {
        version: 1,
        message: expect.stringContaining("completed peer result"),
        source: {
          agentId: peerAgentId,
          sessionKey: sourceKey,
          sessionId: "peer-id",
          lifecycleRevision: "peer-v1",
        },
        target: {
          agentId: "main",
          sessionKey: targetKey,
          sessionId: "requester-id",
          lifecycleRevision: "requester-v1",
        },
        returnedResult: { extraSystemPrompt: expect.stringContaining("returned the result") },
      },
    ]);
    if (restricted || route === "send-only") {
      await expect(
        prepareSessionsSendCommunication({
          config,
          source: peerEndpoint,
          target: requester,
          message: "unsolicited reverse send",
          allowApproval: false,
          callGateway,
        }),
      ).rejects.toThrow();
      expect(admitted).toHaveLength(1);
    }

    // A replacement at the same key must not acquire the old peer's result.
    rows[sourceKey] = { ...source, lifecycleRevision: "peer-v2" };
    await expect(
      runAgentStep({
        agentId: "main",
        sessionKey: targetKey,
        expectedSession: context.requesterSession,
        sourceAgentId: peerAgentId,
        sourceSessionKey: sourceKey,
        replyAdmission,
        expectedSourceSession: source,
        message: "stale result",
        extraSystemPrompt: "Consume once",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).rejects.toThrow("session changed before admission");
    expect(admitted).toHaveLength(1);
  },
);
