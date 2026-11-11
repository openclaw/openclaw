import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { withinTest } from "../../test/helpers/promise.js";
import { addSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  captureSessionQueuedInputsForRestart,
  listSessionPendingInputs,
  readSessionPendingInput,
} from "../config/sessions/session-pending-input-history.js";
import * as pendingInputWithdrawal from "../config/sessions/session-pending-input-withdrawal.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { createAgentDatabaseStartupObservation } from "../state/agent-database-startup-observation.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import * as gatewayDispatch from "./server-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import {
  persistRunningSessionsForRestart,
  prepareAgentRestartRecovery,
  resumeMarkedSessions,
} from "./session-restart-resume.js";
import * as systemTurnAuthority from "./session-system-turn-authority.js";

it("requests original recorded custody only at the actual marked restart admission", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const person = ensureProfileForEmail("restart-source-intent@example.test");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:restart-source-intent",
      sessionId: "restart-source-intent",
    };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: person.id },
    });
    await persistGatewaySessionLifecycleEvent({
      sessionKey: target.sessionKey,
      event: {
        runId: "restart-source-run",
        sessionId: target.sessionId,
        ts: Date.now(),
        data: { phase: "start", startedAt: Date.now() },
      },
    });
    const background = createProcessSessionFixture({
      id: "restart-source-background",
      backgrounded: true,
    });
    background.agentId = target.agentId;
    background.sessionKey = target.sessionKey;
    addSession(background);
    await persistRunningSessionsForRestart({ cfg });
    resetProcessRegistryForTests();
    expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeDefined();
    const context = createContext([], () => cfg);
    const admission = vi
      .spyOn(systemTurnAuthority, "prepareSessionSystemTurnAuthority")
      .mockRejectedValue(new Error("Stop after observing restart admission intent"));
    try {
      await resumeMarkedSessions({
        context,
        signal: new AbortController().signal,
        log: { warn() {} },
      });
      expect(admission).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          preserveRecordedSource: true,
        }),
      );
    } finally {
      admission.mockRestore();
    }
  }));

it.for(["prepared", "managed", "crash", "slow-crash", "failed"] as const)(
  "retains restart work across readable but write-pending preparation (%s)",
  (mode, test) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const crash = mode === "crash" || mode === "slow-crash" || mode === "failed";
      const target = { agentId: "main", sessionKey: "agent:main:prepared" };
      replaceSessionEntrySync(target, { sessionId: "prepared", updatedAt: 110 });
      replaceSessionEntrySync(target, {
        ...loadExactSessionEntry(target)!.entry,
        ...(crash
          ? { lifecycleRunId: "predecessor", startedAt: 110 }
          : { resumeAfterRestart: { queuedInputIds: [] } }),
      });
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const open = createDeferredCore();
      const opened = createDeferredCore();
      const waiting = createDeferredCore();
      const accepted = createDeferredCore<{ ok: true }>();
      const enqueued = createDeferredCore();
      const resume = vi
        .spyOn(sessionEvents, "enqueueSessionEventForHost")
        .mockImplementation(() => {
          enqueued.resolve();
          return {
            accepted: accepted.promise,
            id: "prepared-resume",
            settled: Promise.resolve({
              status: "completed",
              executionStarted: true,
              delivered: false,
            }),
            cancel: () => false,
          };
        });
      const discover = vi.spyOn(pendingInputWithdrawal, "listOrphanedSessionPendingInputTargets");
      let startup: Promise<void> | undefined;
      try {
        await withAgentDatabaseStartupAdmission(async (admission) => {
          const context = createContext([], () => cfg);
          context.agentDatabaseStartup = admission.observation;
          context.resolveGatewayContext = () => context;
          if (crash) {
            context.restartResumeWindows = { main: [{ startedAt: 100, endedAt: 200 }] };
          }
          const params = { context, signal: admission.signal, log: { warn: vi.fn() } };
          const wait = admission.observation.waitForAgentPreparation;
          const preparationWait = vi
            .spyOn(admission.observation, "waitForAgentPreparation")
            .mockImplementation((id, options) => {
              if (options?.forWrite !== false) {
                waiting.resolve();
              }
              return wait(id, options);
            });
          const refusals = admission.defer({
            env: process.env,
            reason: "Controlled write preparation",
            inspections: [
              {
                target: { agentId: "main", path: database.path },
                result: Promise.resolve({
                  incompatible: [],
                  indeterminate: [],
                  readReadyAgentPaths: [database.path],
                }),
              },
            ],
          });
          recordAgentDatabaseAdmissions(refusals, { source: "startup" });
          const owner = admission.adopt();
          admission.activate({
            isCurrent: () => true,
            preparationReady: Promise.resolve(),
            captureReadAdmission: ({ assertCurrent }) => assertCurrent,
            publishAgent: async () => {},
            openAgent: async () => {
              opened.resolve();
              await open.promise;
              if (mode === "failed") {
                throw new Error("Controlled preparation failure");
              }
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
          try {
            await withinTest(opened.promise, test.signal);
            expect(await readSessionEntryReadOnlyInWorker(target)).toMatchObject(
              crash
                ? { lifecycleRunId: "predecessor" }
                : { resumeAfterRestart: { queuedInputIds: [] } },
            );
            expect(admission.observation.isAgentInputRecoveryPending("main")).toBe(false);
            if (mode === "prepared") {
              open.resolve();
              await withinTest(
                Promise.resolve(admission.waitForAgentPreparation("main")),
                test.signal,
              );
              expect(admission.observation.isAgentInputRecoveryPending("main")).toBe(true);
            }
            if (mode === "slow-crash") {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            }
            let startupFinished = false;
            startup = resumeMarkedSessions(params).then(() => {
              startupFinished = true;
            });
            // Managed discovery may return after excluding the store; crash discovery joins it.
            await withinTest(Promise.race([waiting.promise, startup]), test.signal);
            expect(resume).not.toHaveBeenCalled();
            if (mode === "slow-crash") {
              await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS + 60_001);
              vi.useRealTimers();
            }
            const recovering = admission.pendingPreparation!;
            let recovered = false;
            void recovering.then(() => {
              recovered = true;
            });
            open.resolve();
            if (mode !== "failed") {
              await withinTest(Promise.race([enqueued.promise, recovering]), test.signal);
              expect(
                resume,
                JSON.stringify({
                  warnings: params.log.warn.mock.calls,
                  entry: loadExactSessionEntry(target)?.entry,
                }),
              ).toHaveBeenCalledOnce();
              expect(recovered).toBe(false);
              if (mode === "prepared") {
                expect(startupFinished).toBe(false);
              }
              accepted.resolve({ ok: true });
            }
            await withinTest(Promise.all([startup, recovering]), test.signal);
            await resumeMarkedSessions(params);
            expect(resume).toHaveBeenCalledTimes(mode === "failed" ? 0 : 1);
            if (mode === "failed") {
              expect(readAgentDatabaseAdmissionRefusal("main")).toMatchObject({
                code: "agent-database-inspection-failed",
                reason: "Controlled preparation failure",
              });
            } else {
              expect(params.log.warn.mock.calls.flat()).toEqual(
                mode === "prepared"
                  ? []
                  : [
                      "Agent main resume deferred: agent database unavailable (agent-database-inspection-pending)",
                    ],
              );
              expect(discover).toHaveBeenCalledOnce();
              expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
              expect(loadExactSessionEntry(target)?.entry.lifecycleRunId).toBeUndefined();
            }
          } finally {
            vi.useRealTimers();
            open.resolve();
            accepted.resolve({ ok: true });
            await owner.stop();
            await Promise.allSettled(startup ? [startup] : []);
            preparationWait.mockRestore();
          }
        });
      } finally {
        resume.mockRestore();
        discover.mockRestore();
      }
    }),
);

it.each(["crash", "markers", "failed-preparation", "clean-or-unknown"] as const)(
  "bounds orphan recovery to the predecessor and settles abandoned runs (%s)",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {}, other: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionTarget = (name: string) => {
        const agentId = name === "marked" ? "other" : "main";
        return { agentId, sessionKey: `agent:${agentId}:${name}` };
      };
      const cases: Array<[string, Partial<InternalSessionEntry>, boolean]> = [
        ["crash", {}, mode !== "clean-or-unknown"],
        ["yielded", { endedAt: 120 }, false],
        ["stale", { startedAt: 1, updatedAt: 999 }, false],
        ["missing-start", { startedAt: undefined }, false],
        ["new-incarnation", { startedAt: 200 }, false],
        ["completed", { status: "done" }, false],
        ["stopped", { status: "killed", abortedLastRun: true }, false],
        ["archived", { archivedAt: 2 }, false],
        ["external", { modelSelectionLocked: true }, false],
        ["cron:job", {}, false],
        ["subagent:child", {}, false],
        ["dashboard:spawned", { createdVia: "spawn" }, false],
        ["live", {}, false],
        ...(mode === "markers"
          ? [
              ["marked", { resumeAfterRestart: { queuedInputIds: [] } }, true] as [
                string,
                Partial<InternalSessionEntry>,
                boolean,
              ],
            ]
          : []),
      ];
      for (const [name, patch] of cases) {
        const target = sessionTarget(name);
        const { sessionKey } = target;
        const initial = { sessionId: name, updatedAt: 110, createdVia: patch.createdVia };
        replaceSessionEntrySync(target, initial);
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          event: {
            runId: name,
            sessionId: name,
            ts: 110,
            data: { phase: "start", startedAt: 110 },
          },
        });
        const entry = loadExactSessionEntry(target)!.entry;
        expect(entry.lifecycleRunId).toBe(name);
        replaceSessionEntrySync(target, { ...entry, ...patch });
      }
      if (mode === "failed-preparation") {
        recordAgentDatabaseAdmissions(
          [
            {
              agentId: "other",
              paths: [],
              code: "agent-database-inspection-failed",
              reason: "Synthetic completed inspection failure",
              repairHint: "Repair the synthetic database",
            },
          ],
          { source: "startup" },
        );
      }
      const claim = claimAgentRunContext(
        "live",
        { agentId: "main", sessionKey: "agent:main:live", sessionId: "live" },
        { trackOwner: true, ownsContext: true },
      );
      const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
        accepted: Promise.resolve({ ok: true }),
        id: "restart-input",
        settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
        cancel: () => false,
      });
      try {
        for (let boot = 0; boot < 2; boot++) {
          await resumeMarkedSessions({
            context: {
              ...createContext(),
              getRuntimeConfig: () => cfg,
              ...(mode === "failed-preparation"
                ? {
                    agentDatabaseStartup: createAgentDatabaseStartupObservation(
                      new Map(),
                      new AbortController().signal,
                    ),
                  }
                : {}),
              ...(mode !== "clean-or-unknown"
                ? { restartResumeWindows: { main: [{ startedAt: 100, endedAt: 200 }] } }
                : {}),
            },
            signal: new AbortController().signal,
            log: { warn() {} },
          });
        }
        expect(resume.mock.calls.map(([, options]) => options.sessionKey).toSorted()).toEqual(
          cases
            .filter((row) => row[2])
            .map(([name]) => sessionTarget(name).sessionKey)
            .toSorted(),
        );
        expect(
          loadExactSessionEntry({ agentId: "main", sessionKey: "agent:main:stale" })?.entry,
        ).toMatchObject({
          status: "killed",
          abortedLastRun: true,
          lastRunId: "stale",
        });
        expect(
          loadExactSessionEntry({ agentId: "main", sessionKey: "agent:main:stale" })?.entry
            .lifecycleRunId,
        ).toBeUndefined();
        expect(
          loadExactSessionEntry({ agentId: "main", sessionKey: "agent:main:live" })?.entry,
        ).toHaveProperty("lifecycleRunId", "live");
        expect(loadExactSessionEntry(sessionTarget("yielded"))?.entry).toMatchObject({
          status: "failed",
          lastRunError: expect.stringContaining("child completion"),
        });
        expect(
          loadExactSessionEntry(sessionTarget("yielded"))?.entry.lifecycleRunId,
        ).toBeUndefined();
      } finally {
        resume.mockRestore();
        releaseAgentRunContext("live", claim);
      }
    }),
);

it.for(["archived", "incognito"] as const)("does not mark a %s hidden message wait", (kind) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = { agentId: "main", sessionKey: `agent:main:subagent:${kind}` };
    const runId = `parked-${kind}`;
    replaceSessionEntrySync(target, {
      sessionId: runId,
      updatedAt: 1,
      lifecycleRunId: runId,
      activeWriterRunId: runId,
      ...(kind === "archived" ? { archivedAt: 1 } : { incognito: true }),
    });
    subagentRuns.set(
      runId,
      createSubagentRunRecord({
        runId,
        childSessionKey: target.sessionKey,
        childAgentId: target.agentId,
        childSessionIdentity: { sessionId: runId },
        endedAt: 1,
        pauseReason: "sessions_yield",
        waitForMessage: true,
      }),
    );
    try {
      await persistRunningSessionsForRestart({ cfg: {} });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
    } finally {
      subagentRuns.delete(runId);
    }
  }),
);

it("marks the active execution when an older message wait remains in the same session", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:replaced-message-wait",
      sessionId: "replaced-message-wait",
    };
    const runId = "current-execution";
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      lifecycleRunId: runId,
      activeWriterRunId: runId,
    });
    const oldRunId = "old-message-wait";
    subagentRuns.set(
      oldRunId,
      createSubagentRunRecord({
        runId: oldRunId,
        childSessionKey: target.sessionKey,
        childAgentId: target.agentId,
        childSessionIdentity: { sessionId: target.sessionId },
        endedAt: 1,
        pauseReason: "sessions_yield",
        waitForMessage: true,
      }),
    );
    const claim = claimAgentRunContext(runId, target, { trackOwner: true, ownsContext: true });
    try {
      await persistRunningSessionsForRestart({ cfg: {} });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual({
        queuedInputIds: [],
      });
    } finally {
      releaseAgentRunContext(runId, claim);
      subagentRuns.delete(oldRunId);
    }
  }));

it.each(["restart", "user", "completed"] as const)(
  "selects retained %s work at the restart marker snapshot",
  (ending) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const target = {
        agentId: "main",
        sessionKey: `agent:main:before-markers-${ending}`,
        sessionId: `before-markers-${ending}`,
      };
      replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
      const { operation, release } = await withSessionTurn(target, async (active) => {
        assert(active);
        if (ending === "completed") {
          active.freezeAbort();
        }
        return { operation: active, release: active.retainExecution() };
      });
      try {
        if (ending !== "completed") {
          expect(ending === "restart" ? operation.abortForRestart() : operation.abortByUser()).toBe(
            true,
          );
        }
        await persistRunningSessionsForRestart({ cfg: {} });
        expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual(
          ending === "restart" ? { queuedInputIds: [] } : undefined,
        );
      } finally {
        release();
        await operation.ownerSettlement;
      }
    }),
);

it.for([
  "message",
  "nested-message",
  "nested-lost",
  "stale-requester",
  "current-completed",
  "retired-completed",
  "stopped",
  "interrupted",
] as const)("recovers a parked dashboard root from its recorded wake source (%s)", (source) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:parked-root",
      sessionId: "parked-root",
    };
    const runId = "parked-root-run";
    const lifecycleRevision = "parked-root-revision";
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      lifecycleRevision,
      activeWriterRunId: runId,
      updatedAt: 100,
    });
    for (const event of [
      { ts: 100, data: { phase: "start", startedAt: 100 } },
      {
        ts: 120,
        data: {
          phase: "end",
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        },
      },
    ]) {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: target.sessionKey,
        event: { ...event, runId, sessionId: target.sessionId },
      });
    }
    const childRunId = "parked-child-run";
    const childSessionKey = "agent:main:dashboard:parked-child";
    const childSessionId = "parked-child";
    const childRevision = "parked-child-revision";
    const recovery = ["retired-completed", "stopped", "interrupted"].includes(source);
    const completed = source === "current-completed" || source === "retired-completed";
    const child = createSubagentRunRecord({
      runId: childRunId,
      childSessionKey,
      childAgentId: "main",
      childSessionIdentity: { sessionId: childSessionId, lifecycleRevision: childRevision },
      requesterSessionKey: target.sessionKey,
      requesterAgentId: target.agentId,
      completionRequesterSessionId: target.sessionId,
      completionRequesterLifecycleRevision: lifecycleRevision,
      expectsCompletionMessage: true,
      endedAt: source === "interrupted" ? undefined : 110,
      outcome: completed ? { status: "ok" } : undefined,
      endedReason:
        source === "stopped" ? "subagent-killed" : completed ? "subagent-complete" : undefined,
      pauseReason: completed || recovery ? undefined : "sessions_yield",
      waitForMessage: source === "message" || source === "stale-requester" ? true : undefined,
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        requesterRunId: source === "stale-requester" ? "older-root-run" : runId,
        batchRunIds: [childRunId],
      },
    });
    subagentRuns.set(childRunId, child);
    if (source === "retired-completed") {
      subagentRuns.retireCompletionAuthority(child);
    }
    const grandchildRunId = "parked-grandchild-run";
    if (source === "nested-message") {
      subagentRuns.set(
        grandchildRunId,
        createSubagentRunRecord({
          runId: grandchildRunId,
          childSessionKey: "agent:main:dashboard:parked-grandchild",
          childAgentId: "main",
          requesterSessionKey: childSessionKey,
          requesterAgentId: "main",
          completionRequesterSessionId: childSessionId,
          completionRequesterLifecycleRevision: childRevision,
          expectsCompletionMessage: true,
          endedAt: 105,
          pauseReason: "sessions_yield",
          waitForMessage: true,
          requesterSettleWake: {
            status: "pending",
            attemptCount: 0,
            requesterYieldBatch: true,
            requesterRunId: childRunId,
            batchRunIds: [grandchildRunId],
          },
        }),
      );
    }
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "restart-input",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    try {
      await persistRunningSessionsForRestart({ cfg });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual({
        queuedInputIds: [],
      });
      for (let boot = 0; boot < 2; boot++) {
        await resumeMarkedSessions({
          context: createContext([], () => cfg),
          signal: new AbortController().signal,
          log: { warn() {} },
        });
        const restored = (await readSessionEntryReadOnlyInWorker(target))!;
        expect(restored.resumeAfterRestart).toBeUndefined();
        expect(restored.activeWriterRunId).toBe(runId);
        if (source === "message" || source === "nested-message" || source === "current-completed") {
          expect(restored.lifecycleRunId).toBe(runId);
          expect(restored.status).toBeUndefined();
          expect(restored.endedAt).toBe(120);
        } else if (recovery) {
          expect(restored.lifecycleRunId).toBeUndefined();
          expect(restored.status).toBe("killed");
        } else {
          expect(restored.lifecycleRunId).toBeUndefined();
          expect(restored.status).toBe("failed");
          expect(restored.lastRunError).toMatch(/wait|child|restart/i);
        }
      }
      expect(resume).toHaveBeenCalledTimes(recovery ? 1 : 0);
    } finally {
      resume.mockRestore();
      subagentRuns.delete(childRunId);
      subagentRuns.delete(grandchildRunId);
    }
  }),
);

it("marks completed reply settlement only when accepted inputs remain queued", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionKey: "agent:main:completed-before-restart",
      sessionId: "completed-before-restart",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const runId = "completed-worker-reply";
    const { operation, releaseExecution } = await withSessionTurn(target, async (active) => {
      assert(active, "Expected a real reply operation");
      active.attachBackend({ kind: "embedded", runId, cancel() {} });
      active.freezeAbort();
      return { operation: active, releaseExecution: active.retainExecution() };
    });
    const runClaim = claimAgentRunContext(runId, target, { trackOwner: true, ownsContext: true });
    let queued: Awaited<ReturnType<typeof stageSessionPendingInput>> | undefined;
    try {
      await persistRunningSessionsForRestart({ cfg: {} });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();

      queued = await stageSessionPendingInput(target, {
        runId: "queued-behind-completed-reply",
        message: {
          role: "user",
          content: "Continue after the completed reply",
          timestamp: 2,
          idempotencyKey: "queued-behind-completed-reply:user",
        },
        assertCurrent() {},
      });
      assert(queued, "Queued fixture input was not admitted");
      await persistRunningSessionsForRestart({ cfg: {} });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual({
        queuedInputIds: [queued.inputId],
        queuedInputSources: {
          [queued.inputId]: {
            runId: "queued-behind-completed-reply",
            source: { kind: "unavailable" },
          },
        },
      });
    } finally {
      queued?.finish("interrupted");
      await queued?.settled?.();
      releaseExecution();
      await operation.ownerSettlement;
      releaseAgentRunContext(runId, runClaim);
    }
  }));

it("marks ordinary conversations without inheriting cron or external execution ownership", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const cases: Array<{ sessionKey: string; resumable?: true; entry?: Partial<SessionEntry> }> = [
      { sessionKey: "agent:other:main", resumable: true },
      { sessionKey: "agent:other:main:thread:123.456", resumable: true },
      { sessionKey: "agent:main:cron:scheduled:run:occurrence" },
      { sessionKey: "agent:main:acp:external" },
      {
        sessionKey: "agent:main:external-acp-binding",
        entry: {
          acp: {
            backend: "fixture",
            agent: "main",
            runtimeSessionName: "external-runtime",
            mode: "persistent",
            state: "running",
            lastActivityAt: 1,
          },
        },
      },
      { sessionKey: "agent:main:external-harness", entry: { modelSelectionLocked: true } },
    ];
    try {
      for (const { sessionKey, entry, resumable } of cases) {
        const agentId = resumable ? "other" : "main";
        replaceSessionEntrySync(
          { agentId, sessionKey },
          { sessionId: sessionKey, updatedAt: 1, ...entry },
        );
        if (resumable) {
          subagentRuns.set(
            sessionKey,
            createSubagentRunRecord({
              runId: sessionKey,
              childSessionKey: sessionKey,
              childAgentId: agentId,
              requesterSessionKey: "agent:main:cron:scheduled:run:occurrence",
              endedAt: sessionKey.endsWith(":main") ? 1 : undefined,
            }),
          );
        }
        const process = createProcessSessionFixture({ id: sessionKey, backgrounded: true });
        process.agentId = agentId;
        process.sessionKey = sessionKey;
        addSession(process);
      }
      await persistRunningSessionsForRestart({ cfg: {} });
      for (const { sessionKey, resumable } of cases) {
        const entry = loadExactSessionEntry({
          agentId: resumable ? "other" : "main",
          sessionKey,
        })?.entry;
        expect(entry).toBeDefined();
        expect(entry?.resumeAfterRestart, sessionKey).toEqual(
          resumable ? { queuedInputIds: [], hadBackgroundExec: true } : undefined,
        );
      }
    } finally {
      for (const { sessionKey, resumable } of cases) {
        if (resumable) {
          subagentRuns.delete(sessionKey);
        }
      }
      resetProcessRegistryForTests();
    }
  }));

it("settles source-less queued sends even when the recorded owner cannot resume", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "writer",
          definitions: {
            writer: { scopes: ["operator.write"], agents: "*", sessions: { others: "none" } },
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const profile = ensureProfileForEmail("queued-before-revocation@example.test");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:revoked-queued-owner",
      sessionId: "revoked-queued-owner",
    };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    const receipt = await stageSessionPendingInput(target, {
      runId: "queued-before-revocation",
      message: {
        role: "user",
        content: "Accepted before restart",
        timestamp: 1,
        idempotencyKey: "queued-before-revocation:user",
        __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
      },
      assertCurrent() {},
    });
    assert(receipt, "Queued fixture input was not admitted");
    const process = createProcessSessionFixture({ id: "revoked-owner-work", backgrounded: true });
    process.agentId = target.agentId;
    process.sessionKey = target.sessionKey;
    addSession(process);
    try {
      await persistRunningSessionsForRestart({ cfg });
      receipt.finish("interrupted");
      await receipt.settled?.();
      setUserProfileRole(profile.id, "reader");
      const warn = vi.fn();
      await resumeMarkedSessions({
        context: createContext([], () => cfg),
        signal: new AbortController().signal,
        log: { warn },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipped restart resume"));
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
      expect(await readSessionPendingInput(target, receipt.inputId)).toMatchObject({
        state: "cancelled",
        message: { content: "Accepted before restart" },
      });
    } finally {
      receipt?.finish("interrupted");
      await receipt?.settled?.();
      resetProcessRegistryForTests();
    }
  }));

it("fails a captured browser-copilot send instead of running without its live binding", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const profile = ensureGatewayOwnerProfile("Browser owner");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:bound-browser-queue",
      sessionId: "bound-browser-queue",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    const receipt = await stageSessionPendingInput(target, {
      runId: "bound-browser-send",
      message: {
        role: "user",
        content: "Inspect the selected tab",
        timestamp: 1,
        idempotencyKey: "bound-browser-send:user",
        __openclaw: {
          senderIdentity: { type: "profile", id: profile.id },
          transport: {
            clients: [{ id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT, mode: GATEWAY_CLIENT_MODES.UI }],
          },
        },
      },
      assertCurrent() {},
    });
    assert(receipt, "Queued fixture input was not admitted");
    const send = vi.spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess").mockResolvedValue({});
    const context = createContext();
    try {
      const captured = await captureSessionQueuedInputsForRestart(target);
      captured.preserve();
      receipt.finish("interrupted");
      await receipt.settled?.();
      await continueSessionQueuedInputs(context, target, {
        signal: new AbortController().signal,
        queuedInputIds: [receipt.inputId],
        assertCurrent() {},
      });
      expect(send.mock.calls.length).toBe(0);
      expect(await readSessionPendingInput(target, receipt.inputId)).toMatchObject({
        state: "cancelled",
        message: { content: "Inspect the selected tab" },
      });
      expect(context.logGateway.warn).toHaveBeenCalledWith(
        expect.stringContaining("Browser-bound queued input requires a fresh browser send"),
      );
    } finally {
      send.mockRestore();
      receipt.finish("cancelled");
      await receipt.settled?.();
    }
  }));

it("resumes recent interrupted legacy cycles once and settles crash inputs", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = { agentId: "main", sessionKey: "agent:main:crashed", sessionId: "crashed" };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    for (const [name, hoursAgo, status, abortedLastRun, tombstone] of [
      ["legacy", 1, "interrupted", true, undefined],
      ["stale", 7, "interrupted", true, undefined],
      ["done", 1, "done", true, undefined],
      ["killed", 1, "killed", true, undefined],
      ["future", -1, "interrupted", true, undefined],
      ["settled", 1, "interrupted", false, undefined],
      ["retired", 1, "interrupted", true, { reason: "stopped" }],
    ] as const) {
      const entry = {
        sessionId: name,
        updatedAt: Math.floor(performance.timeOrigin) - hoursAgo * 60 * 60 * 1000,
        status,
        abortedLastRun,
        mainRestartRecovery: { cycleId: name, revision: 1, chargedAttempts: 0, tombstone },
      };
      database.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, entry_valid) VALUES (?, ?, ?, ?, 1)",
        )
        .run(`agent:main:${name}`, name, JSON.stringify(entry), entry.updatedAt);
    }
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "upgrade-resume",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    const discover = vi.spyOn(pendingInputWithdrawal, "listOrphanedSessionPendingInputTargets");
    const receipts = [];
    for (const runId of ["crashed", "live"]) {
      const receipt = await stageSessionPendingInput(target, {
        runId,
        assertCurrent() {},
        message: { role: "user", content: runId, timestamp: 1, idempotencyKey: `${runId}:user` },
      });
      assert(receipt, "Expected accepted input");
      receipts.push(receipt);
    }
    const [crashed, live] = receipts;
    const dispatch = vi.spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess");
    try {
      crashed!.finish("interrupted");
      await crashed!.settled?.();
      database.db
        .prepare(
          "UPDATE session_pending_inputs SET state = 'queued', lifecycle_generation = 'previous-process' WHERE input_id = ?",
        )
        .run(crashed!.inputId);
      const warn = vi.fn();
      for (let boot = 0; boot < 2; boot++) {
        await resumeMarkedSessions({
          context: createContext(),
          signal: new AbortController().signal,
          log: { warn },
        });
        expect(discover).toHaveBeenCalledTimes(boot + 1);
        expect((await listSessionPendingInputs(target)).items).toMatchObject([
          { runId: "crashed", state: "cancelled", message: { content: "crashed" } },
          { runId: "live", state: "queued" },
        ]);
      }
      expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual([
        "agent:main:legacy",
      ]);
      expect(resume.mock.calls[0]?.[0]).toContain("The Gateway restarted while you were working.");
      for (const name of ["legacy", "stale", "done", "killed", "future", "settled"]) {
        const persisted = database.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(`agent:main:${name}`);
        expect(JSON.parse(String(persisted?.entry_json))).not.toHaveProperty("mainRestartRecovery");
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      resume.mockRestore();
      discover.mockRestore();
      dispatch.mockRestore();
      live!.finish("cancelled");
      await live!.settled?.();
    }
  }));
