import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  beginGatewayBootLifecycle,
  completeGatewayBootLifecycle,
} from "../infra/gateway-boot-lifecycle.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { prepareAgentRestartRecovery, resumeMarkedSessions } from "./session-restart-resume.js";

it("retains crash recovery across failed admission and a clean intermediate boot", async (test) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const target = (name: string) => ({ agentId: "main", sessionKey: `agent:main:${name}` });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    await beginGatewayBootLifecycle(process.env, 100);
    for (const [name, startedAt] of [
      ["predecessor", 110],
      ["older", 90],
      ["intermediate", 250],
    ] as const) {
      replaceSessionEntrySync(target(name), {
        sessionId: name,
        updatedAt: startedAt,
      });
      await persistGatewaySessionLifecycleEvent({
        sessionKey: target(name).sessionKey,
        event: {
          runId: name,
          sessionId: name,
          ts: startedAt,
          data: { phase: "start", startedAt },
        },
      });
      expect(loadExactSessionEntry(target(name))?.entry.lifecycleRunId).toBe(name);
    }
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "restart-input",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    const log = { warn: vi.fn() };
    const recover = async (
      boot: Awaited<ReturnType<typeof beginGatewayBootLifecycle>>,
      mode: "failed" | "retry",
    ) => {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const context = Object.assign(
          createContext([], () => cfg),
          boot,
        );
        context.agentDatabaseStartup = admission.observation;
        context.resolveGatewayContext = () => context;
        const params = { context, signal: admission.signal, log };
        const opening = createDeferredCore();
        const release = createDeferredCore();
        const refusal = admission.defer({
          env: process.env,
          reason: "Synthetic deferred database preparation",
          inspections: [
            {
              target: { agentId: "main", path: database.path },
              result: Promise.resolve({ incompatible: [], indeterminate: [] }),
            },
          ],
        });
        recordAgentDatabaseAdmissions(refusal, { source: "startup" });
        const owner = admission.adopt();
        let attempts = 0;
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          publishAgent: async () => {},
          openAgent: async () => {
            attempts++;
            if (mode === "failed") {
              throw new Error("Synthetic admission failure");
            }
            if (attempts === 1) {
              throw new WorkerTaskError("worker task capacity reached", "overloaded");
            }
            opening.resolve();
            await release.promise;
          },
          migrateAgent: async ({ assertCurrent }) => ({
            recoverInputs: await prepareAgentRestartRecovery({
              ...params,
              agentId: "main",
              env: process.env,
              assertCurrent,
            }),
          }),
        });
        const preparation = admission.pendingPreparation;
        let startup: Promise<void> | undefined;
        try {
          startup = resumeMarkedSessions(params);
          if (mode === "retry") {
            await withinTest(opening.promise, test.signal);
            expect(resume).not.toHaveBeenCalled();
            expect(readAgentDatabaseAdmissionRefusal("main")?.code).toBe(
              "agent-database-inspection-pending",
            );
            release.resolve();
          }
          await withinTest(Promise.all([startup, preparation]), test.signal);
          await resumeMarkedSessions(params);
          expect(attempts).toBe(mode === "failed" ? 1 : 2);
        } finally {
          release.resolve();
          await owner.stop();
          await Promise.allSettled(startup ? [startup] : []);
        }
      });
    };
    try {
      // No completion for the first boot represents SIGKILL, with no shutdown markers.
      const failed = await beginGatewayBootLifecycle(process.env, 200);
      expect(failed.id).toBeDefined();
      expect(failed.restartResumeWindow).toEqual({ startedAt: 100, endedAt: 200 });
      await recover(failed, "failed");
      expect(resume).not.toHaveBeenCalled();
      expect(readAgentDatabaseAdmissionRefusal("main")?.code).toBe(
        "agent-database-inspection-failed",
      );
      await completeGatewayBootLifecycle(failed.id, { outcome: "clean_stop" }, process.env, 300);
      const recovered = await beginGatewayBootLifecycle(process.env, 400);
      expect(recovered.id).toBeDefined();
      expect(recovered.restartResumeWindow).toBeUndefined();
      await recover(recovered, "retry");
      expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual([
        "agent:main:predecessor",
      ]);
      expect(loadExactSessionEntry(target("predecessor"))?.entry.lifecycleRunId).toBeUndefined();
      for (const name of ["older", "intermediate"]) {
        expect(loadExactSessionEntry(target(name))?.entry).toMatchObject({
          status: "killed",
          lastRunId: name,
        });
      }
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /main.*resume deferred: agent database unavailable|resume deferred: agent database unavailable.*main/u,
        ),
      );
      await completeGatewayBootLifecycle(recovered.id, { outcome: "clean_stop" }, process.env, 500);
      const next = await beginGatewayBootLifecycle(process.env, 600);
      const context = Object.assign(
        createContext([], () => cfg),
        next,
      );
      await resumeMarkedSessions({ context, signal: new AbortController().signal, log });
      expect(resume).toHaveBeenCalledOnce();
    } finally {
      resume.mockRestore();
    }
  }));
