import { expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import {
  captureRequesterContinuationCaller,
  prepareRequesterCronAuthority,
  promoteRequesterCronAuthority,
  consumeRequesterCronAuthorityAdmission,
  revokeRequesterCronAuthority,
} from "../../agents/subagents/requester-cron-authority.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  clearAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { readUserTurnRequesterOrigin } from "../../sessions/user-turn-transcript-admission.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import {
  baseParams,
  createInboundTurn,
  createSessionTurn,
  createProviderSurface,
} from "./get-reply-run.test-support.js";

export function registerPendingRequesterAuthorityCases({
  runPrepared,
  loadSessionEntryMock,
  requireRunReplyAgentCall,
  turn,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  loadSessionEntryMock: { mockReturnValue(value: SessionEntry): unknown };
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
  turn: (
    body: string,
    common: Parameters<typeof runPreparedReply>[0]["ctx"],
    session?: Partial<Parameters<typeof runPreparedReply>[0]["sessionCtx"]>,
    inbound?: Partial<Parameters<typeof runPreparedReply>[0]["ctx"]>,
  ) => Pick<Parameters<typeof runPreparedReply>[0], "ctx" | "sessionCtx">;
}): void {
  it("persists admitted external-contact sender attribution on direct turns", async () => {
    await runPrepared({
      ...turn(
        "hello",
        { OriginatingChannel: "telegram", OriginatingTo: "chat-1", ChatType: "direct" },
        { Provider: "telegram", SenderId: "user-42", SenderName: "Ada", SenderUsername: "ada" },
        { InboundAccessAuthorized: true },
      ),
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "direct",
      },
    });

    const message = requireRunReplyAgentCall().followupRun.userTurnTranscriptRecorder?.message;
    expect(message).toMatchObject({
      __openclaw: { senderId: "user-42", senderName: "Ada", senderUsername: "ada" },
    });
  });

  it.each([
    {
      name: "direct From without sender fields",
      context: { ChatType: "direct", From: " discord:alice " },
      senderId: "discord:alice",
      senderE164: undefined,
    },
    {
      name: "direct From with blank sender fields",
      context: { ChatType: "direct", From: "discord:alice", SenderId: " ", SenderE164: " " },
      senderId: "discord:alice",
      senderE164: undefined,
    },
    {
      name: "group input without a sender",
      context: { ChatType: "group", From: "discord:alice" },
      senderId: undefined,
      senderE164: undefined,
    },
    {
      name: "conversation-shaped From without chat type",
      context: { From: "discord:channel:123" },
      senderId: undefined,
      senderE164: undefined,
    },
    {
      name: "explicit raw sender fields",
      context: {
        ChatType: "direct",
        From: "discord:alice",
        SenderId: "transport-identity",
        SenderE164: "+15550100100",
      },
      senderId: "transport-identity",
      senderE164: "+15550100100",
    },
    {
      name: "phone identity without a sender id",
      context: { ChatType: "direct", From: "discord:alice", SenderE164: "+15550100100" },
      senderId: undefined,
      senderE164: "+15550100100",
    },
  ])("captures requester identity for $name", async ({ context, senderId, senderE164 }) => {
    const params = baseParams();
    params.command.senderId = "configured-owner-alias";
    await runPrepared({
      ...params,
      conversation: undefined,
      ...turn("continue the work", { ...createProviderSurface("discord"), ...context }),
    });
    const { followupRun } = requireRunReplyAgentCall();
    for (const origin of [
      followupRun.run.requesterOrigin,
      readUserTurnRequesterOrigin(followupRun.userTurnTranscriptRecorder),
    ]) {
      expect(origin).toBeDefined();
      expect(origin?.senderId).toBe(senderId);
      expect(origin?.senderE164).toBe(senderE164);
    }
  });
  it.each(["fresh-non-owner", "fresh-owner", "inter-session", "heartbeat", "replay"] as const)(
    "retires pending owner task authority only for new channel input: %s",
    async (kind) => {
      const sessionKey = "agent:default:discord:channel:123";
      const sessionId = "pending-owner-session";
      const originalRunId = "pending-owner-run";
      const child: SubagentRunRecord = {
        runId: "pending-child",
        execution: { status: "running" },
        requesterTurnRunId: originalRunId,
        requesterAgentId: "default",
        childSessionKey: "agent:default:subagent:child",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "discord",
        task: "review",
        cleanup: "keep",
        createdAt: 1,
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: ["pending-child"],
        },
      };
      const batch = [child];
      const runs = new Map([[child.runId, child]]);
      const sessionEntry: SessionEntry = { sessionId, updatedAt: 1, lifecycleRevision: "original" };
      loadSessionEntryMock.mockReturnValue(sessionEntry);
      const { operationalRunInstance } = createTestAdmittedRunContext(originalRunId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      registerAgentRunContext(originalRunId, { sessionKey, sessionId, agentId: "default" });
      const scope = createCronCreatorAuthorityCapability(
        originalRunId,
        { kind: "external", channel: "discord" },
        { source: "channel-owner", isCurrent: () => true },
      )!;
      const params = baseParams();
      setRuntimeConfigSnapshot(params.cfg);
      try {
        await runWithCronCreatorAuthorityCapability(scope, () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "default",
              sessionKey,
              operationalRunInstance,
              approvalAuthority: authority,
            },
            async () => {
              const prepared = prepareRequesterCronAuthority({
                requesterSessionKey: sessionKey,
                requesterAgentId: "default",
                requesterTurnRunId: originalRunId,
              });
              try {
                const capture = await prepared?.bind({ batch, runs });
                expect(capture).toBeDefined();
                capture!.commit();
              } finally {
                await prepared?.release();
              }
            },
          ),
        );
        promoteRequesterCronAuthority({
          requesterTurnRunId: originalRunId,
          batch,
          rearmGeneration: 1,
        });
        const provenance =
          kind === "inter-session"
            ? { kind: "inter_session" as const, sourceTool: "sessions_send" }
            : undefined;
        params.command.senderIsOwner = kind === "fresh-owner";
        await runPrepared({
          ...params,
          conversation: undefined,
          sessionKey,
          sessionId,
          sessionEntry,
          ctx: {
            ...createInboundTurn("new request", "discord", "group"),
            SenderId: "sender",
            InputProvenance: provenance,
          },
          sessionCtx: {
            ...createSessionTurn("new request", "discord", "group"),
            SenderId: "sender",
            InputProvenance: provenance,
          },
          opts: {
            isHeartbeat: kind === "heartbeat",
            suppressNextUserMessagePersistence: kind === "replay",
          },
        });
        expect(runReplyAgent).toHaveBeenCalledOnce();
        await captureRequesterContinuationCaller({
          requesterSessionKey: sessionKey,
          requesterSessionId: sessionId,
          requesterAgentId: "default",
          batch,
          rearmGeneration: 1,
          runId: "successor",
          isCurrent: () => true,
        }).run(async () => {
          const admission = consumeRequesterCronAuthorityAdmission({
            runId: "successor",
            sessionKey,
            sessionId,
            inputProvenance: {
              kind: "inter_session",
              sourceTool: "subagent_settle",
              sourceSessionKey: child.childSessionKey,
            },
          });
          expect(Boolean(admission)).toBe(kind !== "fresh-non-owner" && kind !== "fresh-owner");
          if (admission) {
            expect(admission.callerOrigin).toEqual({ kind: "unknown" });
          }
        });
      } finally {
        revokeRequesterCronAuthority(sessionKey);
        releaseAgentRunDelegatedAuthority(authority);
        clearAgentRunContext(originalRunId);
        clearRuntimeConfigSnapshot();
      }
    },
  );
  it.each(["runtime", "scoped"] as const)(
    "retains the %s config owner for queued admission",
    async (kind) => {
      const params = baseParams();
      const runtimeConfig = params.cfg;
      const scopedConfig = {
        ...runtimeConfig,
        commands: { ownerAllowFrom: ["slack:scoped-owner"] },
      };
      setRuntimeConfigSnapshot(runtimeConfig, runtimeConfig);
      try {
        await runPrepared({ ...params, cfg: kind === "scoped" ? scopedConfig : runtimeConfig });
        const { followupRun } = requireRunReplyAgentCall();
        const nextConfig = { ...runtimeConfig, commands: { ownerAllowFrom: ["slack:next-owner"] } };
        setRuntimeConfigSnapshot(nextConfig, nextConfig);
        expect(followupRun.readAdmissionConfig?.()).toEqual(
          kind === "scoped" ? scopedConfig : nextConfig,
        );
        expect(followupRun.run.config).toEqual(kind === "scoped" ? scopedConfig : runtimeConfig);
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );
}
