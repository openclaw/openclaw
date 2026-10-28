import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import {
  readSessionSendDeliveryAdmission,
  type SessionSendDelivery,
} from "../../gateway/session-send-delivery.js";
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

function peerFixture(
  config: OpenClawConfig,
  peerAgentId = "main",
  restricted?: "receive-only" | "ask-send",
) {
  peer.config = config;
  setRuntimeConfigSnapshot(config);
  const sourceKey = `agent:${peerAgentId}:peer`;
  const targetKey = "agent:main:requester";
  const source = sessionEntry(
    "peer",
    restricted ? { send: restricted === "ask-send" ? "ask" : "never" } : undefined,
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
  return {
    sourceKey,
    targetKey,
    source,
    target,
    rows,
    storeTarget,
    requester: endpoint("main", targetKey, target),
    peerEndpoint: endpoint(peerAgentId, sourceKey, source),
    flow: {
      targetSessionKey: sourceKey,
      targetAgentId: peerAgentId,
      displayKey: "peer",
      replyTimeoutMs: 10_000,
      requesterSessionKey: targetKey,
      requesterAgentId: "main",
    },
    step: {
      agentId: "main",
      sessionKey: targetKey,
      sourceAgentId: peerAgentId,
      sourceSessionKey: sourceKey,
      expectedSession: target,
      expectedSourceSession: source,
      timeoutMs: 10_000,
    },
    accept: (
      runId: string,
      callGateway: AgentToolGatewayRequestCaller = async <T>() => ({ runId }) as T,
    ) =>
      acceptRequest(
        {
          config,
          source: endpoint("main", targetKey, target),
          target: endpoint(peerAgentId, sourceKey, source),
          message: "original request",
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: targetKey,
          },
          callGateway,
        },
        runId,
      ),
  };
}

const communicationConfig = (): OpenClawConfig => ({
  tools: { sessions: { visibility: "all" } },
  session: { communication: { send: "always", receive: "always" } },
});

async function acceptRequest(
  params: Parameters<typeof prepareSessionsSendCommunication>[0],
  runId: string,
) {
  const original = await prepareSessionsSendCommunication(params);
  try {
    expect(() => original.captureReplyAdmission(runId)).toThrow("no accepted source request");
    await original.callGateway({
      method: "agent",
      params: {
        agentId: params.target.agentId,
        sessionKey: params.target.sessionKey,
        message: params.message,
        inputProvenance: params.inputProvenance,
        idempotencyKey: runId,
      },
    });
    expect(() => original.captureReplyAdmission("another-run")).toThrow(
      "no accepted source request",
    );
    return original.captureReplyAdmission(runId);
  } finally {
    original.close();
  }
}

afterEach(() => {
  agentWaitMock.mockReset();
  peer.config = undefined;
  peer.load.mockReset();
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
});

it("surfaces a failed accepted requester continuation without redispatching the peer result", async () => {
  const failure = "Codex thread synthetic-thread is claimed by active work; stop it first.";
  const fixture = peerFixture(communicationConfig());
  const replyAdmission = await fixture.accept(
    "completed-peer-run",
    async <T>(request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
      request.sessionMutationCommitGuard?.();
      return { runId: "completed-peer-run" } as T;
    },
  );
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
      ...fixture.flow,
      callGateway,
      runId: "completed-peer-run",
      requesterSession: fixture.target,
      targetSession: fixture.source,
      replyAdmission,
      reply: {
        status: "ok",
        replyText: "Synthetic peer result",
        terminalReply: { disposition: "visible", text: "Synthetic peer result" },
      },
      deliverRequesterReply: (reply) =>
        runAgentStep({
          ...reply,
          ...fixture.step,
          replyAdmission,
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
    const config = communicationConfig();
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
    const peerAgentId = route === "send-only" ? "research" : "main";
    const restricted = route === "receive-only" || route === "ask-send";
    const fixture = peerFixture(config, peerAgentId, restricted ? route : undefined);
    const { sourceKey, targetKey, source, target, rows, storeTarget, requester, peerEndpoint } =
      fixture;
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
    const replyAdmission = await fixture.accept("peer-run");
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
      admitted.push(admission!.delivery);
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
        ...fixture.flow,
        callGateway,
        replyAdmission,
        displayKey: sourceKey,
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
        ...fixture.step,
        expectedSession: context.requesterSession,
        replyAdmission,
        message: "stale result",
        extraSystemPrompt: "Consume once",
        callGateway,
      }),
    ).rejects.toThrow("session changed before admission");
    expect(admitted).toHaveLength(1);
  },
);
