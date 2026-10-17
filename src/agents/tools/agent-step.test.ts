// Agent step tests cover nested session handoff and
// MCP runtime survival after completed nested turns.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageInjectionAcceptedUnconfirmedError } from "../../auto-reply/reply/message-injection-authority.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { projectForwardedMessages } from "../../gateway/chat-display-projection.history.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
} from "../embedded-agent-runner/runs.js";
import { runAgentStep } from "./agent-step.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

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
    expect(params?.inputProvenance?.sourceTool).toBe("sessions_send");
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
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();
    expect(agentWaitMock).toHaveBeenCalledTimes(3);

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });
});

describe("returned peer results", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
  });
  it.each([
    "accepted",
    "unconfirmed",
    "replaced",
    "lifecycle-changed",
    "replaced-after-acceptance",
    "lifecycle-changed-after-acceptance",
  ] as const)("delivers a completed peer result to the busy requester (%s)", async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:dashboard:synthetic-requester";
      const sessionId = "synthetic-requester-session";
      const scope = { agentId: "main", sessionKey, sessionId };
      await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
      const gatewayCalls: CallGatewayOptions[] = [];
      const callGateway = async <T = unknown>(request: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(request);
        if (request.method === "agent.wait") {
          return { status: "ok", terminalReply: { disposition: "empty" } } as T;
        }
        return { runId: "synthetic-unwanted-next-turn" } as T;
      };
      let queued: EmbeddedAgentQueueMessageOptions | undefined;
      const queueMessage = vi.fn(
        async (_text: string, options?: EmbeddedAgentQueueMessageOptions) => {
          queued = options;
          options?.onQueueAccepted?.(true);
          if (outcome === "unconfirmed") {
            throw new MessageInjectionAcceptedUnconfirmedError();
          }
        },
      );
      const handle: EmbeddedAgentQueueHandle = {
        runId: "synthetic-active-requester-run",
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => {},
        sourceReplyDeliveryMode: "automatic",
        messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
      };
      setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "main");
      try {
        await runSessionsSendA2AFlow({
          callGateway,
          targetSessionKey: "agent:main:dashboard:synthetic-peer",
          targetAgentId: "main",
          displayKey: "synthetic-peer",
          runId: "synthetic-completed-peer-run",
          replyTimeoutMs: 1_000,
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          requesterSession: {
            sessionId: outcome === "replaced" ? "retired-requester-session" : sessionId,
            ...(outcome === "lifecycle-changed" ? { lifecycleRevision: "retired-lifecycle" } : {}),
          },
          reply: {
            status: "ok",
            replyText: "Synthetic peer result",
            terminalReply: { disposition: "visible", text: "Synthetic peer result" },
          },
        });
        expect(gatewayCalls).toEqual([]);
        if (outcome === "replaced" || outcome === "lifecycle-changed") {
          expect(queueMessage).not.toHaveBeenCalled();
          expect(await loadTranscriptEvents(scope)).toEqual([]);
          return;
        }
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(queued?.waitForTranscriptCommit).toBe(false);
        // Admission returns while the receiver still owns consumption. The real
        // transcript recorder must remain usable after the forwarding call ends.
        expect(await loadTranscriptEvents(scope)).toEqual([]);
        const recorder = queued?.userTurnTranscriptRecorder;
        expect(recorder).toBeDefined();
        if (!recorder) {
          throw new Error("Receiver lost its admitted input recorder");
        }
        if (
          outcome === "replaced-after-acceptance" ||
          outcome === "lifecycle-changed-after-acceptance"
        ) {
          await replaceSessionEntry(scope, {
            sessionId: outcome === "replaced-after-acceptance" ? "replacement-session" : sessionId,
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: 2,
          });
          if (outcome === "replaced-after-acceptance") {
            await expect(recorder.persistApproved()).resolves.toBeUndefined();
          } else {
            await expect(recorder.persistApproved()).rejects.toThrow();
          }
          expect(await loadTranscriptEvents(scope)).toEqual([]);
          expect(gatewayCalls).toEqual([]);
          return;
        }
        const persisted = await recorder.persistApproved();
        expect(persisted?.message.provenance).toMatchObject({
          kind: "inter_session",
          sourceTool: "sessions_send",
          sourceSessionKey: "agent:main:dashboard:synthetic-peer",
        });
        const text = JSON.stringify(persisted?.message.content);
        expect(text).toContain("Synthetic peer result");
        expect(queueMessage.mock.calls[0]?.[0]).toContain("This result is delivered once");
        expect(queueMessage.mock.calls[0]?.[0]).toContain("will not be sent back");
        expect(persisted).toBeDefined();
        const projected = projectForwardedMessages([{ ...persisted?.message }]);
        expect(projected[0]).toMatchObject({
          role: "assistant",
          content: "Synthetic peer result",
          senderLabel: expect.stringContaining("Forwarded"),
          senderSession: { sessionKey: "agent:main:dashboard:synthetic-peer" },
        });
        expect(persisted?.message.idempotencyKey).toBeTruthy();
        queued?.onQueueSettled?.();
        const entries = await loadTranscriptEvents(scope);
        expect(entries.filter((entry) => isRecord(entry) && entry.type === "message")).toHaveLength(
          1,
        );
        expect(gatewayCalls).toEqual([]);
        expect(recordParticipant).toHaveBeenCalledOnce();
      } finally {
        queued?.onQueueSettled?.();
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    });
  });
});
