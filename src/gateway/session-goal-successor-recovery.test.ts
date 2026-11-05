import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { claimAgentSessionWriter } from "../agents/embedded-agent-runner/run/session-bootstrap.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createCreateGoalTool } from "../agents/tools/goal-tools.js";
import {
  bindGoalContinuationExecution,
  finishGoalContinuationSettlement,
} from "../auto-reply/reply/goal-continuation-return.js";
import {
  createGoalContinuationReturn,
  enqueueGoalContinuation,
} from "../auto-reply/reply/goal-continuation.js";
import { persistGoalSuccessorCustody } from "../auto-reply/reply/goal-successor-custody.js";
import * as queue from "../auto-reply/reply/queue/enqueue.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import * as events from "../auto-reply/reply/session-event-handoff.js";
import { readSessionEventTargetOperatorAuthority } from "../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  persistSessionGoalSuccessor,
  retireSessionGoalSuccessor,
} from "../config/sessions/goal-successor.js";
import {
  clearSessionGoal,
  createSessionGoal,
  updateSessionGoalStatus,
} from "../config/sessions/goals.js";
import {
  loadExactSessionEntry,
  markSessionAbortTarget,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { captureSessionQueuedInputsForRestart } from "../config/sessions/session-pending-input-history.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { readSessionControllerOperationState } from "../sessions/session-controller.state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayAgentToolIngress } from "./local-user-ingress.js";
import { recoveryFixture, pairedOperator } from "./operator-run-recovery.test-support.js";
import * as gatewayDispatch from "./server-in-process-dispatch.js";
import { recoverSessionGoalSuccessor } from "./session-goal-successor-recovery.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { recordSessionOperatorSource } from "./session-operator-sources.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

// Match the root admission used by runGatewayStartupObservers. Discovery and source
// restoration remain real; only the terminal mailbox/provider handoff is replaced.
function resumeStartup(params: Parameters<typeof resumeMarkedSessions>[0]) {
  return runWithGatewayIndependentRootWorkAdmission(
    () => resumeMarkedSessions(params),
    "startup:session-resume",
    params.signal,
  );
}

async function scenario(
  run: (f: {
    fixture: Awaited<ReturnType<typeof recoveryFixture>>;
    base: FollowupRun;
    persist: () => Promise<boolean>;
    read: () => NonNullable<ReturnType<typeof loadExactSessionEntry>>["entry"];
  }) => Promise<void>,
  createGoal = true,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = ensureProfileForEmail("goal-recovery@example.test");
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const fixture = await recoveryFixture(stateDir, profile.id, {
      device: pairedOperator(),
      config: cfg,
    });
    fixture.context.resolveGatewayContext = () => fixture.context;
    if (createGoal) {
      await createSessionGoal({ ...fixture.target, objective: "Finish the checked deliverable" });
    }
    const source = await fixture.restore();
    if (!source) {
      throw new Error("Fixture authority missing");
    }
    const base: FollowupRun = {
      prompt: "Continue",
      enqueuedAt: 1,
      operatorAuthority: source.authority,
      gatewayLocalUserIngress: prepareGatewayAgentToolIngress({
        agentId: "main",
        representedProfileId: profile.id,
      }),
      toolsAllow: ["read"],
      run: {
        agentId: "main",
        agentDir: stateDir,
        sessionId: fixture.target.sessionId,
        sessionKey: fixture.target.sessionKey,
        sessionFile: fixture.target.sessionKey,
        workspaceDir: stateDir,
        config: cfg,
        provider: "test",
        model: "test",
        timeoutMs: 1000,
        blockReplyBreak: "text_end",
        gatewayUiCommandTarget: { connId: "old-webchat", profileId: profile.id },
        senderIsOwner: false,
        sessionEventOrigin: { deliver: false },
      },
    };
    const read = () => loadExactSessionEntry(fixture.target)!.entry;
    try {
      await run({
        fixture,
        base,
        read,
        persist: () =>
          persistGoalSuccessorCustody({
            base,
            entry: read(),
            sessionKey: fixture.target.sessionKey,
            storePath: fixture.target.storePath,
            sourceRunId: "completed-source",
            phase: "pending",
            assertCurrent: source.authority.assertCurrent,
          }),
      });
    } finally {
      source.release();
    }
  });
}

it("recovers a pending-only WebChat operator pursuit through startup without erasing custody on acceptance", () =>
  scenario(async ({ fixture, persist, read }) => {
    expect(await persist()).toBe(true);
    const saved = read().goalSuccessor!;
    expect(saved.refusal).toBeUndefined();
    expect(saved.source.kind).toBe("gateway");
    expect(read().resumeAfterRestart).toBeUndefined();
    const accepted = createDeferredCore<{ ok: true }>();
    const reached = createDeferredCore();
    // Boundary fixture: real SQLite custody, source restoration, and startup selection;
    // provider execution is deliberately replaced at the ordinary mailbox handoff.
    const enqueue = vi
      .spyOn(events, "enqueueSessionEventForHost")
      .mockImplementation((_text, options) => {
        expect(options.source).toBe("tool_handoff");
        expect(options.deliver).toBe(false);
        expect(options.expectedTarget?.toolsAllow).toEqual(["read"]);
        const authority = readSessionEventTargetOperatorAuthority(options.expectedTarget!);
        expect(authority?.profileId).toBe(fixture.snapshot.profileId);
        authority?.assertCurrent();
        options.assertCurrent?.();
        reached.resolve();
        return {
          id: "recovered",
          accepted: accepted.promise,
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
          cancel: () => false,
        };
      });
    const params = {
      context: fixture.context,
      signal: new AbortController().signal,
      log: { warn: vi.fn() },
    };
    let work: Promise<void> | undefined;
    try {
      work = resumeStartup(params);
      await Promise.race([reached.promise, work]);
      expect(enqueue, JSON.stringify(params.log.warn.mock.calls)).toHaveBeenCalledOnce();
      expect(read().goalSuccessor).toEqual(saved);
      accepted.resolve({ ok: true });
      await work;
      expect(params.log.warn.mock.calls).toEqual([]);
      expect(read().goalSuccessor).toEqual(saved);
      await resumeStartup(params);
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      accepted.resolve({ ok: true });
      await work;
      enqueue.mockRestore();
    }
  }));

it.each(["restart", "stop", "pause", "clear", "complete", "replace"] as const)(
  "fences a real Goal writer without confusing cleanup with pursuit cancellation: %s",
  (action) =>
    scenario(async ({ fixture, base, read }) => {
      const target = fixture.target;
      const runId = "restart-cleanup-writer";
      const operation = createReplyOperation({ ...target, resetTriggered: false });
      const owner = readSessionControllerOperationState(operation)!;
      const enqueue = vi
        .spyOn(events, "enqueueSessionEventForHost")
        .mockImplementation((_text, options) => {
          expect(options.source).toBe("tool_handoff");
          expect(options.deliver).toBe(false);
          expect(options.expectedTarget?.toolsAllow).toEqual(["read"]);
          expect(options.requiredGoal?.identity.goalId).toBe(read().goal!.id);
          const authority = readSessionEventTargetOperatorAuthority(options.expectedTarget!);
          expect(authority?.profileId).toBe(fixture.snapshot.profileId);
          authority!.assertCurrent();
          options.assertCurrent!();
          return {
            id: "fenced-recovery",
            accepted: Promise.resolve({ ok: true }),
            settled: Promise.resolve({
              status: "completed",
              executionStarted: true,
              delivered: false,
            }),
            cancel: () => false,
          };
        });
      let releaseFence: (() => void) | undefined;
      try {
        const writer = await claimAgentSessionWriter({
          ...target,
          sessionTarget: target,
          prompt: base.prompt,
          runId,
          config: base.run.config,
          workspaceDir: base.run.workspaceDir,
          timeoutMs: 1000,
          replyOperation: operation,
        });
        if (!writer) {
          throw new Error("Fixture writer was not admitted");
        }
        releaseFence = owner.registerTerminalProducerFence((isCurrent, options) =>
          writer.revoke(isCurrent, options),
        );
        operation.setPhase("running");
        await persistGatewaySessionLifecycleEvent({
          sessionKey: target.sessionKey,
          event: { runId, sessionId: target.sessionId, ts: Date.now(), data: { phase: "start" } },
        });
        expect(
          await persistGoalSuccessorCustody({
            base,
            entry: read(),
            sessionKey: target.sessionKey,
            storePath: target.storePath,
            sourceRunId: runId,
            phase: "running",
            assertCurrent: () => base.operatorAuthority!.assertCurrent(),
          }),
        ).toBe(true);
        const saved = read().goalSuccessor!;
        expect(read().activeWriterRunId).toBe(runId);
        expect(read().lifecycleRunId).toBe(runId);
        if (action === "restart") {
          await persistRunningSessionsForRestart({ cfg: base.run.config });
          expect(read().resumeAfterRestart).toEqual({ queuedInputIds: [] });
          operation.abortForRestart();
        } else {
          if (action === "stop") {
            expect((await markSessionAbortTarget({ scope: target }))?.persisted).toBe(true);
          } else if (action === "clear" || action === "replace") {
            await clearSessionGoal(target);
            if (action === "replace") {
              await createSessionGoal({ ...target, objective: "A different pursuit" });
            }
          } else {
            await updateSessionGoalStatus({
              ...target,
              status: action === "pause" ? "paused" : "complete",
            });
          }
          expect(read().goalSuccessor).toBeUndefined();
          operation.abortByUser();
        }
        // The production cleanup owner calls the registered real writer fence; no timer or reducer stub.
        expect(await owner.forceCleanup(() => true)).toBe(true);
        expect(read().activeWriterRunId).toBeUndefined();
        expect(read().status).toBe("killed");
        if (action === "restart") {
          expect(read().goalSuccessor).toEqual(saved);
          expect(read().goal?.status).toBe("active");
          expect(read().resumeAfterRestart).toEqual({ queuedInputIds: [] });
        } else {
          expect(read().goalSuccessor).toBeUndefined();
        }
        const log = { warn: vi.fn() };
        await resumeStartup({
          context: fixture.context,
          signal: new AbortController().signal,
          log,
        });
        expect(log.warn.mock.calls).toEqual([]);
        expect(enqueue).toHaveBeenCalledTimes(action === "restart" ? 1 : 0);
      } finally {
        releaseFence?.();
        operation.complete();
        await operation.ownerSettlement;
        enqueue.mockRestore();
      }
    }),
);

it("refuses recovery into another physical store even when its session and Goal identities match", () =>
  scenario(async ({ fixture, persist, read }) => {
    await persist();
    const original = read();
    const rerouted = {
      ...fixture.target,
      storePath: path.join(path.dirname(fixture.target.storePath), "rerouted.sqlite"),
    };
    // New-row installation intentionally strips inherited custody. Establish the
    // second row, then publish its receipt through the real custody writer.
    await replaceSessionEntry(rerouted, original);
    expect(await persistSessionGoalSuccessor(rerouted, original.goalSuccessor!, () => {})).toBe(
      true,
    );
    expect(loadExactSessionEntry(rerouted)?.entry.goalSuccessor).toEqual(original.goalSuccessor);
    const cfg = {
      agents: { entries: { main: {} } },
      session: { store: rerouted.storePath },
    };
    fixture.setConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const enqueue = vi.spyOn(events, "enqueueSessionEventForHost");
    const log = { warn: vi.fn() };
    try {
      await recoverSessionGoalSuccessor({
        context: fixture.context,
        target: fixture.target,
        successor: original.goalSuccessor!,
        signal: new AbortController().signal,
        log,
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(
        log.warn.mock.calls.some(([message]) =>
          message.includes("Goal destination changed before recovery admission."),
        ),
      ).toBe(true);
      expect(read().goal?.status).toBe("paused");
      expect(read().goalSuccessor).toBeUndefined();
      expect(loadExactSessionEntry(rerouted)?.entry.goalSuccessor).toEqual(original.goalSuccessor);
      expect(loadExactSessionEntry(rerouted)?.entry.goal?.status).toBe("active");
    } finally {
      enqueue.mockRestore();
    }
  }));

it.each(["stop", "pause"] as const)("does not recover a %s superseded successor", (action) =>
  scenario(async ({ fixture, persist, read }) => {
    await persist();
    if (action === "stop") {
      await markSessionAbortTarget({ scope: fixture.target });
    } else {
      await updateSessionGoalStatus({ ...fixture.target, status: "paused" });
    }
    expect(read().goalSuccessor).toBeUndefined();
    const enqueue = vi.spyOn(events, "enqueueSessionEventForHost");
    try {
      await resumeStartup({
        context: fixture.context,
        signal: new AbortController().signal,
        log: { warn: vi.fn() },
      });
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      enqueue.mockRestore();
    }
  }),
);

it("does not let late disposal remove a newer successor", () =>
  scenario(async ({ fixture, base, persist, read }) => {
    await persist();
    const original = read().goalSuccessor!;
    await persistGoalSuccessorCustody({
      base,
      entry: read(),
      sessionKey: fixture.target.sessionKey,
      storePath: fixture.target.storePath,
      sourceRunId: "newer-source",
      phase: "pending",
      assertCurrent() {},
    });
    await retireSessionGoalSuccessor(fixture.target, original, () => {});
    expect(read().goalSuccessor?.sourceRunId).toBe("newer-source");
  }));

it("visibly pauses a browser-bound source instead of restoring a broader session principal", () =>
  scenario(async ({ fixture, base, persist, read }) => {
    base.run.toolBindings = { browser: { tabId: 1 } };
    await persist();
    const enqueue = vi.spyOn(events, "enqueueSessionEventForHost");
    try {
      await resumeStartup({
        context: fixture.context,
        signal: new AbortController().signal,
        log: { warn: vi.fn() },
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(read().goalSuccessor).toBeUndefined();
      expect(read().goal?.status).toBe("paused");
      expect(read().goal?.lastStatusNote).toContain("could not resume");
    } finally {
      enqueue.mockRestore();
    }
  }));

it("defers startup to the existing child batch and releases only after its settlement", () =>
  scenario(async ({ fixture, base, read }) => {
    expect(
      await persistGoalSuccessorCustody({
        base,
        entry: read(),
        sessionKey: fixture.target.sessionKey,
        storePath: fixture.target.storePath,
        sourceRunId: "completed-source",
        phase: "children",
        childRunIds: ["child-1"],
        assertCurrent() {
          base.operatorAuthority?.assertCurrent();
        },
      }),
    ).toBe(true);
    const registry = await import("../agents/subagents/registry/subagent-registry.js");
    // The child registry owns reconciliation; fix its external publication for this startup boundary test.
    const children = vi.spyOn(registry, "listUnsettledRequesterChildren").mockResolvedValue([
      {
        runId: "child-1",
        childSessionKey: "agent:main:subagent:child",
        state: "completing",
        wakeArmed: true,
      },
    ]);
    const enqueue = vi.spyOn(events, "enqueueSessionEventForHost").mockReturnValue({
      id: "child-return",
      accepted: Promise.resolve({ ok: true }),
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    const params = {
      context: fixture.context,
      signal: new AbortController().signal,
      log: { warn: vi.fn() },
    };
    try {
      await resumeStartup(params);
      expect(enqueue).not.toHaveBeenCalled();
      expect(read().goalSuccessor).toMatchObject({ phase: "children", childRunIds: ["child-1"] });
      expect(params.log.warn.mock.calls).toEqual([]);
      children.mockResolvedValue([]);
      const child: SubagentRunRecord = {
        runId: "child-1",
        childSessionKey: "agent:main:subagent:child",
        requesterAgentId: fixture.target.agentId,
        requesterSessionKey: fixture.target.sessionKey,
        requesterStorePath: fixture.target.storePath,
        requesterDisplayKey: fixture.target.sessionKey,
        requesterTurnRunId: "completed-source",
        task: "Check deliverable",
        cleanup: "keep",
        createdAt: 1,
        execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
      };
      await withPluginRuntimeGatewayContextResolver(
        () => fixture.context,
        () =>
          Promise.all([
            finishGoalContinuationSettlement([child], true),
            finishGoalContinuationSettlement([child], true),
          ]),
      );
      expect(
        enqueue,
        JSON.stringify(vi.mocked(fixture.context.logGateway.warn).mock.calls),
      ).toHaveBeenCalledTimes(1);
      expect(read().goal?.status).toBe("active");
      expect(read().goalSuccessor?.phase).toBe("children");
    } finally {
      enqueue.mockRestore();
      children.mockRestore();
    }
  }));

it("publishes a tool-created Goal as running before the tool returns, then pending before mailbox insertion", () =>
  scenario(async ({ fixture, base, read }) => {
    const operation = createReplyOperation({
      sessionKey: fixture.target.sessionKey,
      sessionId: fixture.target.sessionId,
      resetTriggered: false,
    });
    const params = {
      base,
      expectedSession: read(),
      sessionKey: fixture.target.sessionKey,
      storePath: fixture.target.storePath,
      queueKey: fixture.target.sessionKey,
      settings: { mode: "followup" as const, debounceMs: 0 },
      operation,
      runFollowup: async () => {},
    };
    const enqueue = vi.spyOn(queue, "enqueueFollowupRun").mockImplementation(() => {
      expect(read().goalSuccessor?.phase).toBe("pending");
      return true;
    });
    try {
      await createGoalContinuationReturn(params)(async () => {
        await bindGoalContinuationExecution("tool-source", fixture.target.sessionKey);
        expect(read().goalSuccessor).toBeUndefined();
        await createCreateGoalTool({
          runId: "tool-source",
          runSessionKey: fixture.target.sessionKey,
          config: { session: { store: fixture.target.storePath } },
        }).execute("create-goal", { objective: "Finish the checked deliverable" });
        expect(read().goalSuccessor).toMatchObject({
          phase: "running",
          sourceRunId: "tool-source",
          goalId: read().goal!.id,
          source: { kind: "gateway" },
          toolsAllow: [["read"]],
          deliver: false,
        });
        expect(
          await enqueueGoalContinuation({
            ...params,
            sourceRunId: "tool-source",
            result: { meta: { durationMs: 0, stopReason: "stop" } },
          }),
        ).toBe(true);
      });
      expect(enqueue).toHaveBeenCalledOnce();
    } finally {
      operation.complete();
      await operation.ownerSettlement;
      enqueue.mockRestore();
    }
  }, false));

it.for(["keep", "pause"] as const)(
  "admits saved human FIFO inputs before a startup Goal event (%s)",
  (action, { signal }) =>
    scenario(async ({ fixture, persist, read }) => {
      // Accepted human chat records its authenticated source before shutdown;
      // the profile alone is not an authority on this untiered fixture Gateway.
      await recordSessionOperatorSource({
        ...fixture.target,
        authority: fixture.sourceAuthority,
        log: { warn: (message) => expect.fail(message) },
      });
      await persist();
      const queued: NonNullable<Awaited<ReturnType<typeof stageSessionPendingInput>>>[] = [];
      const admissions: string[] = [];
      const reached = createDeferredCore();
      const proceed = createDeferredCore();
      const send = vi
        .spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess")
        .mockImplementation(async (method, params) => {
          expect(method).toBe("chat.send");
          if (!params || typeof params !== "object" || !("idempotencyKey" in params)) {
            throw new Error("Queued human input lost its request identity");
          }
          admissions.push(String(params.idempotencyKey));
          reached.resolve();
          await withinTest(proceed.promise, signal);
          if (action === "pause") {
            await updateSessionGoalStatus({ ...fixture.target, status: "paused" });
          }
          return {};
        });
      const enqueue = vi.spyOn(events, "enqueueSessionEventForHost").mockImplementation(() => {
        admissions.push("goal");
        return {
          id: "fifo-goal",
          accepted: Promise.resolve({ ok: true }),
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
          cancel: () => false,
        };
      });
      let startup: Promise<void> | undefined;
      const log = { warn: vi.fn() };
      try {
        for (const [index, runId] of ["older-human", "newer-human"].entries()) {
          const receipt = await stageSessionPendingInput(fixture.target, {
            runId,
            message: {
              role: "user",
              content: runId,
              timestamp: index + 1,
              idempotencyKey: `${runId}:user`,
              __openclaw: { senderIdentity: { type: "profile", id: fixture.snapshot.profileId } },
            },
            assertCurrent() {},
          });
          if (!receipt) {
            throw new Error("Human FIFO fixture was not staged");
          }
          queued.push(receipt);
        }
        await replaceSessionEntry(fixture.target, {
          ...read(),
          resumeAfterRestart: { queuedInputIds: queued.map((item) => item.inputId) },
        });
        const captured = await captureSessionQueuedInputsForRestart(fixture.target);
        captured.preserve();
        for (const receipt of queued) {
          receipt.finish("interrupted");
          await receipt.settled?.();
        }
        startup = resumeStartup({ context: fixture.context, signal, log });
        await withinTest(
          awaitGateBeforeSettlement(
            reached.promise,
            startup,
            "Startup ended without restoring saved human input",
          ),
          signal,
        );
        expect(admissions).toEqual(["older-human"]);
        expect(enqueue).not.toHaveBeenCalled();
        proceed.resolve();
        await withinTest(startup, signal);
        expect(admissions, JSON.stringify(log.warn.mock.calls)).toEqual(
          action === "pause"
            ? ["older-human", "newer-human"]
            : ["older-human", "newer-human", "goal"],
        );
        if (action === "pause") {
          expect(read().goal?.status).toBe("paused");
          expect(read().goalSuccessor).toBeUndefined();
        }
      } finally {
        proceed.resolve();
        await startup;
        send.mockRestore();
        enqueue.mockRestore();
        for (const receipt of queued) {
          receipt.finish("cancelled");
          await receipt.settled?.();
        }
      }
    }),
);
