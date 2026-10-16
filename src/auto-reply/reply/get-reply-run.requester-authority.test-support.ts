import { expect, it, vi } from "vitest";
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
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  clearAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import {
  baseParams,
  createInboundTurn,
  createSessionTurn,
  createProviderSurface,
  ownerParams,
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
  ) => Pick<Parameters<typeof runPreparedReply>[0], "ctx" | "sessionCtx">;
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
        clearRuntimeConfigSnapshot();
      }
    },
  );
  it.each([
    "owner-alias",
    "non-owner",
    "heartbeat",
    "room-event",
    "spawned",
    "inter-session",
    "replay",
    "revoked-before-bind",
    "revoked",
  ] as const)(
    "admits configured Discord owner management through the reply ingress and real automation tool: %s",
    async (kind) => {
      const runId = "discord-owner-management";
      const cfg = { commands: { ownerAllowFrom: ["discord:owner-1"] } };
      const admitted = kind === "owner-alias" || kind === "revoked";
      setRuntimeConfigSnapshot(cfg);
      const { operationalRunInstance } = createTestAdmittedRunContext(runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const identity: AgentRuntimeIdentity = {
        kind: "agentRuntime",
        agentId: "default",
        sessionKey: "agent:default:discord:channel:123",
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
      };
      const calls: string[] = [];
      vi.mocked(runReplyAgent).mockImplementationOnce(async ({ opts }) => {
        await withGatewayToolCallerIdentity(
          { ...identity, approvalAuthority: authority },
          async () => {
            if (kind === "revoked-before-bind") {
              setRuntimeConfigSnapshot({});
            }
            const tool = createCronTool(
              { runId: opts?.runId, agentSessionKey: identity.sessionKey },
              {
                callGatewayTool: async <T>(method: string) => {
                  const grant = getGatewayToolCallerIdentity()?.cronManagementGrant;
                  if (!admitted) {
                    expect(grant).toBeUndefined();
                    calls.push("restricted");
                    return { jobs: [], total: 0, hasMore: false } as T;
                  }
                  expect(grant, "configured owner must receive a management grant").toBeDefined();
                  return await withCronManagementGrant(grant!, identity, method, async () => {
                    const assertActive = getCronManagementAuthority(identity)!;
                    assertActive();
                    await Promise.resolve();
                    if (kind === "revoked") {
                      setRuntimeConfigSnapshot({});
                    }
                    assertActive();
                    calls.push(method);
                    return { jobs: [], total: 0, hasMore: false } as T;
                  });
                },
              },
            );
            if (kind === "revoked") {
              await expect(tool.execute("list", { action: "list" })).rejects.toThrow(
                "Automation admin grant",
              );
            } else {
              await tool.execute("list", { action: "list" });
            }
          },
        );
        return undefined;
      });
      try {
        const params = ownerParams();
        params.command.senderId = "owner-1";
        params.command.senderIsOwner = kind !== "non-owner";
        await runPrepared({
          ...params,
          conversation: undefined,
          cfg,
          ...turn("list automations", {
            ...createProviderSurface("discord"),
            ChatType: "group",
            SenderId: kind === "owner-alias" ? "transport-alias" : "owner-1",
            InputProvenance:
              kind === "inter-session"
                ? { kind: "inter_session", sourceTool: "sessions_send" }
                : undefined,
            InboundEventKind: kind === "room-event" ? "room_event" : undefined,
          }),
          sessionEntry:
            kind === "spawned"
              ? { sessionId: "spawned-session", updatedAt: 1, spawnedBy: "agent:parent:main" }
              : undefined,
          opts: {
            runId,
            isHeartbeat: kind === "heartbeat",
            suppressNextUserMessagePersistence: kind === "replay",
          },
        });
        expect(calls).toEqual(kind === "revoked" ? [] : admitted ? ["cron.list"] : ["restricted"]);
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
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
