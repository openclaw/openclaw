import { expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
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
import { bindRequesterProfile } from "../requester-profile.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import {
  baseParams,
  createProviderSurface,
  type createPreparedReplyTurn,
} from "./get-reply-run.test-support.js";

type ReplyParams = Parameters<typeof runPreparedReply>[0];
export function registerPendingRequesterAuthorityCases({
  runPrepared,
  loadSessionEntryMock,
  requireRunReplyAgentCall,
  turn,
}: {
  runPrepared: (overrides?: Partial<ReplyParams>) => ReturnType<typeof runPreparedReply>;
  loadSessionEntryMock: { mockReturnValue(value: SessionEntry): unknown };
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
  turn: typeof createPreparedReplyTurn;
}): void {
  it("retains a linked nonadmin requester as the causal origin of delegated work", async () => {
    const params = turn("Please inspect this", {
      ...createProviderSurface("x"),
      SenderId: "10",
      AccountId: "default",
    });
    bindRequesterProfile(params.ctx, {
      id: "linked-human",
      displayName: "Ada",
      isCurrent: () => true,
    });
    await runPrepared(params);
    const run = requireRunReplyAgentCall().followupRun;
    expect(run.operatorAuthority).toBeUndefined();
    expect(run.run.requesterOrigin).toMatchObject({ delegatedCreatorProfileId: "linked-human" });
  });

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

  type IdentityCase = [string, ReplyParams["ctx"], string?, string?];
  const direct = { ChatType: "direct", From: " discord:alice " };
  const phone = "+15550100100";
  const rawId = "transport-identity";
  it.each<IdentityCase>([
    ["blank sender", { ...direct, SenderId: " ", SenderE164: " " }, "discord:alice"],
    ["senderless group", { ChatType: "group", From: "discord:alice" }],
    ["conversation From", { From: "discord:channel:123" }],
    ["raw sender", { ...direct, SenderId: rawId, SenderE164: phone }, rawId, phone],
    ["phone only", { ...direct, SenderE164: phone }, undefined, phone],
  ])("captures requester identity for %s", async (_name, context, senderId, senderE164) => {
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
      expect([origin?.senderId, origin?.senderE164]).toEqual([senderId, senderE164]);
    }
  });
  it.each(["fresh-non-owner", "fresh-owner", "inter-session", "replay"] as const)(
    "retires pending owner task authority only for new channel input: %s",
    async (kind) => {
      const sessionKey = "agent:default:discord:channel:123";
      const sessionId = "pending-owner-session";
      const originalRunId = "pending-owner-run";
      const child = createSubagentRunRecord({
        runId: "pending-child",
        requesterTurnRunId: originalRunId,
        requesterAgentId: "default",
        childSessionKey: "agent:default:subagent:child",
        requesterSessionKey: sessionKey,
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: ["pending-child"],
        },
      });
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
          ...turn("new request", {
            ...createProviderSurface("discord"),
            ChatType: "group",
            SenderId: "sender",
            InputProvenance: provenance,
          }),
          opts: { suppressNextUserMessagePersistence: kind === "replay" },
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
}
