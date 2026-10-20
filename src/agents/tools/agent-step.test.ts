import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayDedupeEntry } from "../../gateway/agent-turn/agent-job.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  readSessionSendDelivery,
  readSessionSendDeliveryAdmission,
  type SessionSendDelivery,
} from "../../gateway/session-send-delivery.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionFollowupCompletion } from "../subagents/completion/session-followup-completion.js";
import { runAgentStep } from "./agent-step.js";
import type { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { prepareSessionsSendCommunication } from "./sessions-send-communication.js";
import {
  startSessionsSendReplyFlow,
  finishSessionsSendReply,
  prepareSessionsSendReplyContext,
} from "./sessions-send-reply-flow.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import { startSessionsSendAgentRun } from "./sessions-send-tool.delivery.js";

const replyFixture = vi.hoisted(() => ({
  context: vi.fn<() => GatewayRequestContext | undefined>(),
  caller: vi.fn<() => ReturnType<typeof getGatewayToolCallerIdentity>>(),
  warn: vi.fn(),
}));
vi.mock("./gateway-caller-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-caller-context.js")>()),
  getGatewayToolCallerIdentity: replyFixture.caller,
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn: replyFixture.warn }),
}));
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
    replyFixture.context() ?? (peer.config ? { getRuntimeConfig: () => peer.config } : undefined),
  runWithGatewayToolContinuationContext: (work: () => Promise<unknown>) => work(),
}));
vi.mock("../../gateway/session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/session-utils-store-worker.js")>()),
  resolveGatewaySessionStoreTargetInWorker: peer.load,
}));

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

const agentWaitMock = vi.hoisted(() => vi.fn());

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

afterEach(() => {
  replyFixture.context.mockReset();
  replyFixture.caller.mockReset();
  replyFixture.warn.mockReset();
  agentWaitMock.mockReset();
  peer.config = undefined;
  peer.load.mockReset();
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
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
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
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

it.each(["happy", "requester-replaced", "custody-revoked", "send-withdrawn"] as const)(
  "confines retained full peer answers before Gateway I/O (%s)",
  async (variant) => {
    const config: OpenClawConfig = {
      tools: { sessions: { visibility: "all" } },
      session: { communication: { send: "always", receive: "always" } },
    };
    peer.config = config;
    setRuntimeConfigSnapshot(config);
    const requesterKey = "agent:main:requester";
    const workerKey = "agent:main:worker";
    const requester = sessionEntry("requester");
    const worker = sessionEntry("worker");
    const rows: Record<string, SessionEntry> = { [requesterKey]: requester, [workerKey]: worker };
    peer.load.mockImplementation(async ({ key }: { key: string }) => ({
      agentId: "main",
      canonicalKey: key,
      storePath: "/fixture/sessions",
      store: rows,
    }));
    const endpoint = (sessionKey: string, entry: SessionEntry) => ({
      agentId: "main",
      sessionKey,
      storePath: "/fixture/sessions",
      entry,
    });
    const runId = "retained-authority-" + variant;
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceTool: "sessions_send",
      sourceSessionKey: requesterKey,
    };
    const original = await prepareSessionsSendCommunication({
      config,
      source: endpoint(requesterKey, requester),
      target: endpoint(workerKey, worker),
      message: "original",
      inputProvenance,
      callGateway: async <T>() => ({ runId }) as T,
    });
    await original.callGateway({
      method: "agent",
      params: {
        agentId: "main",
        sessionKey: workerKey,
        message: "original",
        idempotencyKey: runId,
        inputProvenance,
      },
    });
    const admission = original.captureReplyAdmission(runId);
    original.close();
    const context = createContext([], () => config);
    replyFixture.context.mockReturnValue(context);
    replyFixture.caller.mockReturnValue({
      agentId: "main",
      sessionKey: requesterKey,
      gatewayContextResolver: () => context,
    });
    const full = "A".repeat(5_000) + "AUTHORITY_UNIQUE_TAIL";
    const preview = "A".repeat(4_095) + "…";
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: "agent:" + runId,
      session: {
        agentId: "main",
        sessionKey: workerKey,
        sessionId: worker.sessionId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      entry: {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "ok", result: { meta: { finalAssistantVisibleText: full } } },
      },
    });
    const reads = vi.spyOn(context.dedupe, "get");
    const terminal = createDeferredCore<{
      status: "ok";
      replyText: string;
      terminalReply: { disposition: "visible"; text: string };
    }>();
    const done = createDeferredCore();
    replyFixture.warn.mockImplementation(() => done.resolve());
    let revoked = false;
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("Completion custody revoked");
      }
    };
    const completion =
      variant === "custody-revoked"
        ? SessionFollowupCompletion.bind({
            runId,
            requesterSessionKey: requesterKey,
            requesterSessionId: requester.sessionId,
            requesterAgentId: "main",
            targetSessionKey: workerKey,
            targetAgentId: "main",
            custody: {
              run: (work) => work(),
              assertCurrent,
              signal: new AbortController().signal,
              release() {},
            },
          })
        : undefined;
    completion?.markAccepted(runId);
    const gatewayCalls: Parameters<AgentToolGatewayRequestCaller>[0][] = [];
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => {
      gatewayCalls.push(request);
      if (request.method === "agent.wait") {
        return (await terminal.promise) as T;
      }
      request.sessionMutationCommitGuard?.();
      done.resolve();
      return {
        runId: (request.params as { idempotencyKey: string }).idempotencyKey,
        status: "ok",
        inputProcessingCompleted: true,
      } as T;
    };
    revoked = variant === "custody-revoked";
    try {
      await startSessionsSendReplyFlow({
        runId,
        skip: false,
        completion,
        ...(completion
          ? {
              reply: {
                status: "ok" as const,
                replyText: preview,
                terminalReply: { disposition: "visible" as const, text: preview },
              },
            }
          : {}),
        replyMode: "peer",
        targetAgentId: "main",
        targetSessionKey: workerKey,
        targetSession: worker,
        requesterAgentId: "main",
        requesterSessionKey: requesterKey,
        requesterSession: requester,
        displayKey: workerKey,
        replyTimeoutMs: 1000,
        replyAdmission: admission,
        callGateway,
      });
      if (variant === "requester-replaced") {
        rows[requesterKey] = {
          ...requester,
          sessionId: "replacement",
          lifecycleRevision: "replacement",
        };
      }
      if (variant === "send-withdrawn") {
        rows[requesterKey] = { ...requester, communication: { send: "never" } };
      }
      const reply = {
        status: "ok" as const,
        replyText: preview,
        terminalReply: { disposition: "visible" as const, text: preview },
      };
      if (!completion) {
        terminal.resolve(reply);
      }
      await done.promise;
      const effects = gatewayCalls.filter((request) => request.method !== "agent.wait");
      if (variant === "requester-replaced" || variant === "custody-revoked") {
        expect(effects).toHaveLength(0);
        expect(reads.mock.calls.filter(([key]) => key === "agent:" + runId)).toHaveLength(0);
      } else {
        expect(effects).toHaveLength(1);
        expect(effects[0]?.params).toMatchObject({ message: expect.stringContaining(full) });
        expect(effects[0]?.params).toMatchObject({
          extraSystemPrompt: expect.not.stringContaining("The reply may be truncated."),
        });
      }
    } finally {
      completion?.close();
    }
  },
);
