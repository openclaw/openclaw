import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, type MockInstance } from "vitest";
import {
  readRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { markRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { getRuntimeConfig } from "../config/config.js";
import { createSessionGoal } from "../config/sessions/goals.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  compactRecoveryChild,
  compactRecoverySession,
  createOperatorRecoveryFixture,
} from "./operator-run-recovery.test-support.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { goalAgentResult } from "./server.chat-goal.test-support.js";
import { agentCommandMock } from "./test-helpers.js";

export function registerGoalRecoveryContinuationCase(
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  getContext: () => GatewayRequestContext,
  userMessages: () => readonly unknown[],
): void {
  it("hands an interrupted Goal to the reply owner through consecutive finals without a human turn", async () => {
    const context = getContext();
    const { sessionId, storePath } = scope();
    const profile = ensureProfileForEmail("goal-recovery@example.test");
    const fixture = await createOperatorRecoveryFixture({
      ...scope(),
      stateDir: path.dirname(storePath),
      context,
      profileId: profile.id,
      config: getRuntimeConfig(),
      sourceRunId: "interrupted-goal-original",
    });
    const goal = await createSessionGoal({
      ...scope(),
      objective: "Finish the recovered three-turn checklist",
      actor: { type: "human", id: profile.id },
    });
    const { sourceRunId } = fixture.target;
    await patchSessionEntryCore(scope(), () => ({
      lifecycleRunId: sourceRunId,
      status: undefined,
      restartRecoveryDeliveryRunId: undefined,
      restartRecoveryDeliverySourceRunId: undefined,
    }));
    await markRestartAbortedMainSessions({
      resolveGatewayContext: () => context,
      activeRuns: [
        { ...scope(), runId: sourceRunId, lifecycleGeneration: getAgentEventLifecycleGeneration() },
      ],
      isActiveRun: () => true,
    });
    // The baseline command route also finishes successfully; only reply ownership
    // can continue this exact Goal after that successful final.
    agentCommandMock.mockImplementation(async (options) => {
      options.onExecutionStarted?.();
      return {
        ...goalAgentResult(sessionId, "A recovered command final."),
        payloads: [{ text: "A recovered command final.", mediaUrl: null }],
        meta: { ...goalAgentResult(sessionId, "").meta, stopReason: "end_turn" },
      };
    });
    let recoveredCron: Parameters<typeof executeEmbeddedAgent>[0]["cronCreatorAuthorityCapability"];
    let child: Awaited<ReturnType<typeof compactRecoveryChild>> | undefined;
    let replyAuthority: AdmittedRunOperatorAuthority | undefined;
    runEmbeddedAgent.mockImplementation(async (params) => {
      if (runEmbeddedAgent.mock.calls.length === 1) {
        replyAuthority = expectDefined(
          readRunOperatorAuthority(params),
          "real recovered Goal policy",
        );
        child = await compactRecoveryChild({ context, target: scope() }, replyAuthority);
        recoveredCron = params.cronCreatorAuthorityCapability;
        expect(recoveredCron?.active).toBe(true);
        expect(recoveredCron?.managementEntitlement).toEqual({ source: "control-ui-admin" });
        expect(recoveredCron?.isCurrent?.()).toBe(true);
      }
      if (runEmbeddedAgent.mock.calls.length === 3) {
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal ? { ...entry.goal, status: "complete" } : undefined,
        }));
      }
      const result = goalAgentResult(params.sessionId, "A recovered normal final.");
      return { ...result, meta: { ...result.meta, stopReason: "end_turn" } };
    });
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => createGatewayMethodRegistry([]),
      isDispatchAvailable: () => true,
    });
    context.recoveryRuntime = runtime.recovery;
    bindGatewayContextResolver(runtime.recovery, context.resolveGatewayContext);
    try {
      const recovered = await withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          recoverStore({
            cfg: getRuntimeConfig(),
            storePath,
            handledSessionKeys: new Set(),
            expectedTarget: scope(),
            gatewayRuntime: runtime.recovery,
          }),
      );
      const drained = await waitForGatewayActiveWork(30_000);
      expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
      expect(recovered.failed).toBe(0);
      expect(child?.operatorAuthority?.signal?.aborted).toBe(false);
      expect(child?.operatorAuthority?.assertCurrent).not.toThrow();
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
      expect(recoveredCron?.active).toBe(false);
      expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain("Advance the active goal");
      expect(runEmbeddedAgent.mock.calls[2]?.[0].prompt).toContain("Advance the active goal");
      expect(loadSessionEntry(scope())).toMatchObject({
        sessionId,
        goal: { id: goal.id, status: "complete", continuationTurns: 2 },
      });
      expect(
        userMessages().every((message) => isRecord(message) && message.display === false),
      ).toBe(true);
      const reply = expectDefined(replyAuthority, "same-session reply authority");
      const compacted = await compactRecoverySession(
        scope(),
        reply.assertCurrent,
        "recovered-parent-compaction",
      );
      expect(reply.assertCurrent).not.toThrow();
      expect(child?.operatorAuthority?.assertCurrent).not.toThrow();
      await replaceSessionEntry(scope(), {
        ...compacted.entry,
        sessionId: "reset-after-goal-compaction",
        lifecycleRevision: "reset-revision",
      });
      expect(reply.assertCurrent).toThrow();
      expect(child?.operatorAuthority?.assertCurrent).toThrow();
      expect(child?.operatorAuthority?.signal?.aborted).toBe(true);
    } finally {
      child?.release();
      runtime.close();
    }
  });
}
