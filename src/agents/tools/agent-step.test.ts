// Agent step tests cover nested session handoff and
// MCP runtime survival after completed nested turns.
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("runAgentStep", () => {
  afterEach(() => {
    agentWaitMock.mockReset();
    peer.config = undefined;
    peer.load.mockReset();
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
  });

  it("preserves bundle MCP runtime after successful nested agent steps", async () => {
    // Nested steps disable automatic delivery and carry provenance so the reply
    // returns through the message tool path instead of the channel.
    const gatewayCalls: CallGatewayOptions[] = [];
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
      if (opts.method === "agent.wait") {
        return await agentWaitMock(opts);
      }
      gatewayCalls.push(opts);
      return { runId: "run-nested" } as T;
    };
    agentWaitMock.mockResolvedValue({
      status: "ok",
      terminalReply: { disposition: "visible", text: "done" },
    });
    setRuntimeConfigSnapshot({});

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        agentId: "main",
        sourceAgentId: "research",
        sourceTool: "subagent_announce",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();

    expect(gatewayCalls[0]).toMatchObject({ replyExpectation: "optional" });
    const params = gatewayCalls[0]?.params as
      | {
          message?: string;
          sessionKey?: string;
          deliver?: boolean;
          sourceReplyDeliveryMode?: string;
          lane?: string;
          inputProvenance?: { kind?: string; sourceTool?: string };
        }
      | undefined;
    expect(params?.message).toContain("[Inter-session message");
    expect(params?.sessionKey).toBe("agent:main:subagent:child");
    expect(params?.deliver).toBe(false);
    expect(params?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(params?.lane).toBe("nested:agent:main:subagent:child");
    expect(params?.inputProvenance?.kind).toBe("inter_session");
    expect(params?.inputProvenance?.sourceTool).toBe("subagent_announce");
    expect(params?.message).toContain("isUser=false");
    expect(params?.message).toContain("hello");
    expect(recordParticipant).toHaveBeenCalledOnce();
    expect(recordParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { type: "agent", id: "research" },
        agentId: "main",
        sessionKey: "agent:main:subagent:child",
        promptedAt: expect.any(Number),
      }),
    );
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("waits for the nested reply through queued and nonterminal timeout observations", async () => {
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> =>
      opts.method === "agent.wait" ? await agentWaitMock(opts) : ({ runId: "run-pending" } as T);
    agentWaitMock
      .mockResolvedValueOnce({ status: "pending", timeoutPhase: "queue" })
      .mockResolvedValueOnce({ status: "timeout" })
      .mockResolvedValueOnce({
        status: "ok",
        terminalReply: { disposition: "visible", text: "late reply" },
      });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        sourceTool: "subagent_announce",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();
    expect(agentWaitMock).toHaveBeenCalledTimes(3);

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it.each(["direct", "cron-fallback", "receive-only", "ask-send", "send-only"] as const)(
    "admits %s peer results durably under the captured session incarnations",
    async (route) => {
      const config: OpenClawConfig = {
        tools: { sessions: { visibility: "all" } },
        session: { communication: { send: "always", receive: "always" } },
        ...(route === "send-only"
          ? {
              agents: {
                entries: {
                  main: { tools: { agentToAgent: { send: ["research"] } } },
                  research: { tools: { agentToAgent: { send: [] } } },
                },
              },
              tools: {
                sessions: { visibility: "self" },
                agentToAgent: { enabled: true, allow: ["main", "research"] },
              },
            }
          : {}),
      };
      peer.config = config;
      setRuntimeConfigSnapshot(config);
      const peerAgentId = route === "send-only" ? "research" : "main";
      const sourceKey = `agent:${peerAgentId}:peer`;
      const targetKey = "agent:main:requester";
      const source: SessionEntry = {
        sessionId: "peer-id",
        lifecycleRevision: "peer-v1",
        updatedAt: 1,
        ...(route === "receive-only" ? { communication: { send: "never" as const } } : {}),
        ...(route === "ask-send" ? { communication: { send: "ask" as const } } : {}),
      };
      const target: SessionEntry = {
        sessionId: "requester-id",
        lifecycleRevision: "requester-v1",
        updatedAt: 1,
        ...(route === "receive-only" || route === "ask-send"
          ? { communication: { receive: "never" as const } }
          : {}),
      };
      const rows: Record<string, SessionEntry> = { [sourceKey]: source, [targetKey]: target };
      peer.load.mockImplementation(async ({ key }: { key: string }) => ({
        agentId: key === sourceKey ? peerAgentId : "main",
        canonicalKey: key,
        storePath: "/fixture/sessions",
        store: rows,
      }));
      const original = await prepareSessionsSendCommunication({
        config,
        source: {
          agentId: "main",
          sessionKey: targetKey,
          storePath: "/fixture/sessions",
          entry: target,
        },
        target: {
          agentId: peerAgentId,
          sessionKey: sourceKey,
          storePath: "/fixture/sessions",
          entry: source,
        },
        message: "original request",
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "sessions_send",
          sourceSessionKey: targetKey,
        },
        callGateway: async <T>() => ({ runId: "peer-run" }) as T,
      });
      expect(() => original.captureReplyAdmission("peer-run")).toThrow(
        "no accepted source request",
      );
      await original.callGateway({
        method: "agent",
        params: {
          agentId: peerAgentId,
          sessionKey: sourceKey,
          message: "original request",
          idempotencyKey: "peer-run",
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: targetKey,
          },
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
        requesterTarget: {
          agentId: "main",
          canonicalKey: targetKey,
          storeKeys: [targetKey],
          storePath: "/fixture/sessions",
          store: rows,
        },
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
            inputProvenance: {
              kind: "inter_session",
              sourceTool: "sessions_send",
              sourceSessionKey: targetKey,
            },
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
        ) =>
          request.method === "agent.wait"
            ? ({
                status: "ok",
                replyText: "completed peer result",
                terminalReply: { disposition: "visible", text: "completed peer result" },
              } as T)
            : callGateway<T>(request);
        await finishSessionsSendReply({
          start,
          registryCompletion: false,
          watchField: {},
          replyContext: { ...context, callGateway: followupGateway },
          targetSession: {
            agentId: "main",
            canonicalKey: sourceKey,
            storeKeys: [sourceKey],
            storePath: "/fixture/sessions",
            store: rows,
          },
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
          reply: {
            status: "ok",
            replyText: "completed peer result",
            terminalReply: { disposition: "visible", text: "completed peer result" },
          },
        });
      }
      expect(admitted).toHaveLength(1);
      expect(admitted[0]).toMatchObject({
        version: 1,
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
      });
      expect(admitted[0]!.message).toContain("completed peer result");
      if (route === "receive-only" || route === "ask-send" || route === "send-only") {
        await expect(
          prepareSessionsSendCommunication({
            config,
            source: {
              agentId: peerAgentId,
              sessionKey: sourceKey,
              storePath: "/fixture/sessions",
              entry: source,
            },
            target: {
              agentId: "main",
              sessionKey: targetKey,
              storePath: "/fixture/sessions",
              entry: target,
            },
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
});
