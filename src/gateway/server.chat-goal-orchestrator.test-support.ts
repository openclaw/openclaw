import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAdmittedRunActiveAssertion } from "../agents/admitted-run-context.js";
import { createTestOperatorAuthority } from "../agents/admitted-run-context.test-support.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "../agents/tools/in-process-gateway.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import { getRuntimeConfig } from "../config/config.js";
import { createSessionGoal, updateSessionGoalStatus } from "../config/sessions/goals.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { goalAgentResult } from "./server.chat-goal.test-support.js";

export function registerOrchestratorGoalResumeCases({
  scope,
  runEmbeddedAgent,
  rpc,
  getContext,
  profileClient,
  waitForDispatchEnd,
}: {
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string };
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>;
  rpc: (
    method: "sessions.goal.update",
    params: Record<string, unknown>,
    onResponse?: RespondFn,
    requestClient?: GatewayClient,
  ) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
  getContext: () => GatewayRequestContext;
  profileClient: (id: string) => GatewayClient;
  waitForDispatchEnd: () => Promise<void>;
}) {
  it.each([false, true])(
    "resumes a blocked Goal through the orchestrator tool, preserving newer Pause=%s",
    async (pauseBeforeAdmission) => {
      const { sessionKey, sessionId } = scope();
      const context = getContext();
      const profile = ensureProfileForEmail("goal-orchestrator@example.test");
      let callerOpen = true;
      const authority = createTestOperatorAuthority({
        profileId: profile.id,
        scopes: ["operator.admin"],
        assertCurrent: () => {
          if (!callerOpen) throw new Error("Orchestrator reply ended");
        },
      });
      const cfg = getRuntimeConfig();
      await patchSessionEntryCore(scope(), () => ({
        createdActor: { type: "human", source: "profile", id: profile.id },
      }));
      const original = await createSessionGoal({
        ...scope(),
        objective: "Verify the synthetic artifact",
        tokenBudget: 1000,
      });
      await updateSessionGoalStatus({
        ...scope(),
        status: "blocked",
        note: "Waiting for the artifact",
      });
      const release = createDeferred();
      const entered = createDeferred();
      runEmbeddedAgent.mockImplementation(async (params) => {
        entered.resolve();
        await release.promise;
        const admission = params.preparedRunAdmission;
        if (!admission) throw new Error("Missing resumed run admission");
        const assertTool = resolveAdmittedRunActiveAssertion(await admission.admit("embedded"));
        if (!assertTool) throw new Error("Missing resumed tool authority");
        assertTool();
        await updateSessionGoalStatus({ ...scope(), status: "complete" });
        return goalAgentResult(params.sessionId, "Synthetic artifact verified.");
      });
      let resumeParams: Record<string, unknown> | undefined;
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: Parameters<AgentToolGatewayRequestCaller>[0],
      ) => {
        const respond = vi.fn<RespondFn>();
        if (request.method === "sessions.goal.update" && isRecord(request.params)) {
          resumeParams = request.params;
        }
        if (pauseBeforeAdmission && request.method === "sessions.goal.update") {
          await updateSessionGoalStatus({
            ...scope(),
            status: "paused",
            note: "Newer operator Pause",
          });
        }
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "orchestrator-goal-resume",
            method: request.method,
            params: request.params,
          },
          context,
          client: profileClient(profile.id),
          respond,
          isWebchatConnect: () => true,
          sessionMutationCommitGuard: request.sessionMutationCommitGuard,
        });
        const [ok, result, error] = respond.mock.calls[0]!;
        if (!ok) throw new Error(JSON.stringify(error));
        return result as T;
      };
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:dashboard:orchestrator",
        config: cfg,
        callGateway,
      });
      try {
        const execution = withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:dashboard:orchestrator",
            operatorAuthority: authority,
          },
          () =>
            tool.execute("resume-synthetic-goal", {
              action: "goal_resume",
              sessionKey,
              expectedSessionId: sessionId,
              note: "The operator supplied the artifact and requested Resume.",
            }),
        );
        if (pauseBeforeAdmission) {
          await expect(execution).rejects.toThrow();
          expect(loadSessionEntry(scope())?.goal).toMatchObject({
            id: original.id,
            status: "paused",
            lastStatusNote: "Newer operator Pause",
          });
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          return;
        }
        const result = await execution;
        callerOpen = false;
        expect(result.details).toMatchObject({ status: "started", goalId: original.id });
        expect(loadSessionEntry(scope())?.goal).toMatchObject({
          id: original.id,
          status: "active",
          tokenBudget: 1000,
        });
        await entered.promise;
      } finally {
        release.resolve();
      }
      await waitForDispatchEnd();
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      const replay = await rpc(
        "sessions.goal.update",
        resumeParams!,
        undefined,
        profileClient(profile.id),
      );
      expect(replay.mock.calls[0]).toEqual([
        true,
        expect.objectContaining({ goalId: original.id, replayed: true }),
        undefined,
      ]);
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(loadSessionEntry(scope())?.goal).toMatchObject({
        id: original.id,
        createdAt: original.createdAt,
        status: "complete",
        tokenBudget: 1000,
      });
    },
  );
}
