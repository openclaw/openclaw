import path from "node:path";
import { expect, it, vi } from "vitest";
import { discoverRestartRecoveryStoreTargets } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionStoreTarget } from "../config/sessions/targets-collision.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createQuestionRecovery } from "./question-recovery.js";

it("reports a refused configured recovery source while preserving its healthy sibling after preparation settles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { healthy: {}, refused: {} } } };
    for (const agentId of ["healthy", "refused"]) {
      await replaceSessionEntry(
        { agentId, env: state.env, sessionKey: `agent:${agentId}:main` },
        { sessionId: agentId, lifecycleRevision: `${agentId}-generation`, updatedAt: 1 },
      );
    }
    const refusal = {
      agentId: "refused",
      paths: [path.join(state.sessionsDir("refused"), "sessions.sqlite")],
      code: "agent-database-inspection-failed" as const,
      reason: "Synthetic deferred native inspection failure",
      repairHint: "Repair the original configured source before retrying.",
    };
    recordAgentDatabaseAdmissions([refusal], { env: state.env, source: "startup" });
    // Native pendingPreparation uses allSettled; fulfilled readiness does not clear refusals.
    let preparation: Promise<unknown> | undefined = Promise.allSettled([
      Promise.reject(new Error("inspection failed")),
    ]);
    const unavailable: Array<{ target: SessionStoreTarget; error: unknown }> = [];
    const params = {
      cfg,
      stateDir: state.stateDir,
      onUnavailable: (target: SessionStoreTarget, error: unknown) =>
        unavailable.push({ target, error }),
    };
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const recover = vi.fn(async (_scope: { agentId?: string }) => {});
    const owner = createQuestionRecovery({
      scheduler,
      discover: async () => {
        const refusedSources: unknown[] = [];
        const targets = await discoverRestartRecoveryStoreTargets({
          ...params,
          onUnavailable: (_target, error) => refusedSources.push(error),
        });
        return {
          scopes: targets.map((target) =>
            Object.assign({}, target, { sessionKey: `agent:${target.agentId}:main` }),
          ),
          unavailable: refusedSources,
        };
      },
      pendingPreparation: () => {
        const pending = preparation;
        preparation = undefined;
        return pending;
      },
      recover,
      assertCurrent: () => {},
      track: (run) => Promise.resolve().then(run),
      warn: () => {},
    });
    try {
      const targets = await discoverRestartRecoveryStoreTargets(params);
      expect(targets.map(({ agentId }) => agentId)).toEqual(["healthy"]);
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]?.target.agentId).toBe("refused");
      expect(unavailable[0]?.error).toMatchObject({ refusal });
      await owner.recover();
      expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["healthy"]);
      await expect(owner.waitForRecovery()).rejects.toThrow("remains unavailable");
      recordAgentDatabaseAdmissions([], { env: state.env, source: "startup" });
      await clock.advanceBy(2_000);
      await owner.waitForRecovery();
      expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["healthy", "refused"]);
      expect(scheduler.nextWakeAtMs).toBeNull();
      unavailable.length = 0;
      expect(
        (await discoverRestartRecoveryStoreTargets(params))
          .map(({ agentId }) => agentId)
          .toSorted(),
      ).toEqual(["healthy", "refused"]);
      expect(unavailable).toEqual([]);
    } finally {
      await owner.stop();
      await scheduler.stop();
      recordAgentDatabaseAdmissions([], { env: state.env, source: "startup" });
    }
  });
});
