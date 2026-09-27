import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { settleRequesterTurnAfterSessionSpawns } from "../../agents/subagents/registry/subagent-registry-requester-yield.js";
import * as registry from "../../agents/subagents/registry/subagent-registry.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import {
  createFollowupRun,
  createRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import { resolveModelFallbackOptions as resolveActualModelFallbackOptions } from "./agent-runner-run-params.js";
import { resolveModelFallbackOptions } from "./agent-runner-utils.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

const state = await setupAgentRunnerExecutionTestState();

describe("channel requester settlement identity", () => {
  it.each([true, false])(
    "settles private children against the transcript owner (explicit turn key: %s)",
    async (explicitSessionKey) => {
      const sessionKey = "agent:main:main";
      const followupRun = createFollowupRun();
      const turn = createRunAgentTurnParams(followupRun);
      turn.sessionKey = explicitSessionKey ? sessionKey : undefined;
      turn.sessionCtx = {
        Provider: "telegram",
        ChatType: "direct",
        AccountId: "default",
        SenderId: "fixture-peer",
        SessionKey: sessionKey,
      };
      const policyKey = resolveRuntimePolicySessionKey({
        agentId: "main",
        cfg: followupRun.run.config,
        ctx: turn.sessionCtx,
        sessionKey,
      });
      expect(policyKey).not.toBe(sessionKey);
      followupRun.run.sessionKey = sessionKey;
      followupRun.run.runtimePolicySessionKey = policyKey;
      // The shared harness normally omits selection.sessionKey; use its real producer here.
      vi.mocked(resolveModelFallbackOptions).mockImplementationOnce(
        resolveActualModelFallbackOptions,
      );
      const runs = new Map<string, SubagentRunRecord>();
      const persistOrThrow = vi.fn();
      const schedule = vi.fn();
      const settlement = vi
        .spyOn(registry, "settleRequesterAfterSessionSpawns")
        .mockImplementation((params) =>
          settleRequesterTurnAfterSessionSpawns({ ...params, runs, persistOrThrow, schedule }),
        );
      onTestFinished(() => settlement.mockRestore());
      let child: SubagentRunRecord | undefined;
      state.runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          assert(params.preparedRunAdmission);
          await params.preparedRunAdmission.admit("embedded");
          child = {
            runId: "private-child",
            taskRunId: "private-child",
            childSessionKey: "agent:main:subagent:private-child",
            requesterSessionKey: sessionKey,
            requesterAgentId: "main",
            requesterDisplayKey: "main",
            requesterTurnRunId: params.runId,
            task: "private fixture",
            cleanup: "keep",
            createdAt: 1_000,
            execution: { status: "terminal", endedAt: 2_000 },
            expectsCompletionMessage: true,
            completionTarget: "parent",
            delivery: { status: "pending" },
            cleanupHandled: false,
          };
          runs.set(child.runId, child);
          return {
            payloads: [{ text: "Worker started." }],
            acceptedSessionSpawns: [
              {
                runId: child.runId,
                childSessionKey: child.childSessionKey,
                expectsCompletionMessage: true,
              },
            ],
            meta: { durationMs: 1 },
          };
        },
      );

      const execute = await getExecuteAgentTurnForTest();
      const result = await execute(turn);

      expect(result.kind).toBe("success");
      expect(child).toBeDefined();
      expect(persistOrThrow).toHaveBeenCalledExactlyOnceWith("private-child");
      expect(child?.requesterTurnRunId).toBeUndefined();
      expect(schedule.mock.calls.map((call) => call[2])).toEqual(["completion", "settle"]);
      expect(state.runEmbeddedAgentEntryMock.mock.calls[0]?.[0]).toMatchObject({
        identity: { sessionKey },
        harness: { sessionKey: policyKey },
      });
    },
  );
});
