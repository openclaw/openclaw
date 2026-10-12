import { expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import {
  prepareRequesterCronAuthority,
  promoteRequesterCronAuthority,
  consumeRequesterCronAuthorityAdmission,
  revokeRequesterCronAuthority,
  withRequesterCronAuthority,
} from "../../agents/subagents/requester-cron-authority.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  clearAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { baseParams, createInboundTurn, createSessionTurn } from "./get-reply-run.test-support.js";

export function registerPendingRequesterAuthorityCases({
  runPrepared,
  loadSessionEntryMock,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  loadSessionEntryMock: { mockReturnValue(value: SessionEntry): unknown };
}): void {
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
        const params = baseParams();
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
        await withRequesterCronAuthority(
          {
            requesterSessionKey: sessionKey,
            requesterSessionId: sessionId,
            requesterAgentId: "default",
            batch,
            rearmGeneration: 1,
            runId: "successor",
            isCurrent: () => true,
          },
          async () => {
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
          },
        );
      } finally {
        revokeRequesterCronAuthority(sessionKey);
        releaseAgentRunDelegatedAuthority(authority);
        clearAgentRunContext(originalRunId);
      }
    },
  );
}
